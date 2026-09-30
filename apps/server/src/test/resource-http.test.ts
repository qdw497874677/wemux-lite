import test from 'node:test'
import assert from 'node:assert/strict'
import { nodeResourceRoutes } from '../http/routes/node-resource-routes.js'

function route(method: string, pattern: string) {
  const found = nodeResourceRoutes.find(item => item.method === method && item.pattern === pattern)
  assert.ok(found)
  assert.equal(found.auth, 'admin')
  return found
}

function context(overrides: Record<string, unknown> = {}) {
  const output: { status?: number; body?: unknown } = {}
  const resources = {
    resources: () => [{ id: 'resource-1' }],
    presets: () => [{ id: 'preset-1', revision: 1 }],
    presetApplications: () => [{ application: { id: 'application-1' }, items: [] }],
    resource: () => ({ id: 'resource-1' }),
    revisions: () => [{ id: 'revision-1' }],
    bindings: () => [{ id: 'binding-1' }],
    bindingProjections: () => [{ binding: { id: 'binding-1' }, reconcile: null }],
    desiredSet: () => ({ workerId: 'worker-1', revision: 1, bindings: [] }),
    createResource: (value: unknown) => value,
    updateResource: (value: unknown) => value,
    createRevision: (value: unknown) => value,
    createBinding: (value: unknown) => value,
    transitionBinding: (_id: string, status: string) => ({ id: 'binding-1', status }),
  }
  return {
    output,
    value: {
      resources, params: {}, url: new URL('http://localhost/resources'),
      operator: async () => 'user-1', readBody: async () => ({}),
      json: (status: number, body: unknown) => { output.status = status; output.body = body },
      ...overrides,
    } as never,
  }
}

test('resource management routes are administrator-only and expose catalog, bindings and desired set', async () => {
  const listed = context()
  await route('GET', '/resources').handler(listed.value)
  assert.deepEqual(listed.output.body, { items: [{ id: 'resource-1' }] })

  const bindings = context()
  await route('GET', '/resource-bindings').handler(bindings.value)
  assert.deepEqual(bindings.output.body, { items: [{ binding: { id: 'binding-1' }, reconcile: null }] })

  const candidatesRoute = nodeResourceRoutes.find(item => item.method === 'GET' && item.pattern === '/workers/:workerId/projects/:projectId/provider-candidates')
  assert.equal(candidatesRoute?.auth, 'authenticated')
  let ownerValidated = false
  let workerValidated = false
  let received: unknown
  const candidate = context({
    params: { workerId: 'worker-1', projectId: 'project-1' }, url: new URL('http://localhost/workers/worker-1/projects/project-1/provider-candidates?agentKey=pi'),
    actor: async () => 'viewer-1',
    projects: { require: async () => { ownerValidated = true } },
    workerAccess: { require: async () => { workerValidated = true } },
    resources: { providerCandidates: (...args: unknown[]) => { received = args; return [{ modelId: 'openai-compatible::test', status: 'not-verified' }] } },
  })
  await candidatesRoute!.handler(candidate.value)
  assert.equal(ownerValidated && workerValidated, true)
  assert.deepEqual(received, ['worker-1', 'project-1', 'pi'])
  assert.deepEqual(candidate.output.body, { items: [{ modelId: 'openai-compatible::test', status: 'not-verified' }] })
  const forbidden = context({
    params: { workerId: 'worker-1', projectId: 'project-1' }, url: new URL('http://localhost/workers/worker-1/projects/project-1/provider-candidates?agentKey=pi'), actor: async () => 'viewer-1',
    projects: { require: async () => { throw new Error('forbidden-project') } }, workerAccess: { require: async () => { throw new Error('must-not-leak-worker') } }, resources: { providerCandidates: () => { throw new Error('must-not-query') } },
  })
  await assert.rejects(async () => candidatesRoute!.handler(forbidden.value), /forbidden-project/)
  const desired = context({ params: { workerId: 'worker-1' } })
  await route('GET', '/workers/:workerId/resource-set').handler(desired.value)
  assert.deepEqual(desired.output.body, { workerId: 'worker-1', revision: 1, bindings: [] })
})

test('Provider version route requires admin and reports CAS conflicts without persisting a revision', async () => {
  const target = route('POST', '/resources/:resourceId/provider-revisions')
  let operatorChecked = false
  let input: unknown
  const published = context({
    params: { resourceId: 'provider-1' }, operator: async () => { operatorChecked = true; return 'operator' },
    readBody: async () => ({ expectedVersion: 1, revision: { id: 'v2', kind: 'model-provider' } }),
    resources: { publishProviderRevision: async (resourceId: string, body: unknown) => { input = { resourceId, body }; return { id: 'v2' } } },
  })
  await target.handler(published.value)
  assert.equal(operatorChecked, true)
  assert.deepEqual(input, { resourceId: 'provider-1', body: { expectedVersion: 1, revision: { id: 'v2', kind: 'model-provider' } } })
  assert.equal(published.output.status, 201)
  const stale = context({ params: { resourceId: 'provider-1' }, readBody: async () => ({ expectedVersion: 1, revision: {} }), resources: { publishProviderRevision: async () => { throw new Error('provider_version_conflict') } } })
  await assert.rejects(async () => target.handler(stale.value), (error: { status: number; code: string }) => error.status === 409 && error.code === 'provider_version_conflict')
})

test('Preset routes require administrator and derive actor; invalid and conflicted writes return structured HTTP errors', async () => {
  const presets = context()
  await route('GET', '/resource-presets').handler(presets.value)
  assert.deepEqual(presets.output.body, { items: [{ id: 'preset-1', revision: 1 }] })
  const applications = context()
  await route('GET', '/resource-preset-applications').handler(applications.value)
  assert.deepEqual(applications.output.body, { items: [{ application: { id: 'application-1' }, items: [] }] })
  let received: unknown
  const created = context({ readBody: async () => ({ id: 'preset-1', name: '节点预设', description: '', entries: [], expectedRevision: 0, createdBy: 'forged' }), resources: { createPreset: (body: unknown) => { received = body; return body } } })
  await route('POST', '/resource-presets').handler(created.value)
  assert.equal((received as { createdBy: string }).createdBy, 'user-1')
  assert.equal(created.output.status, 201)
  const applied = context({ params: { presetId: 'preset-1' }, readBody: async () => ({ workerId: 'worker-1', requestId: 'request-1', expectedSetRevision: 0, presetRevision: 1, createdBy: 'forged' }), service: { getWorker: async () => ({ id: 'worker-1' }) }, resources: { applyPreset: (body: unknown) => { received = body; return body } } })
  await route('POST', '/resource-presets/:presetId/applications').handler(applied.value)
  assert.equal((received as { createdBy: string }).createdBy, 'user-1')
  assert.equal(applied.output.status, 201)
  const conflict = context({ readBody: async () => ({}), resources: { createPreset: () => { throw new Error('preset_revision_conflict') } } })
  await assert.rejects(async () => route('POST', '/resource-presets').handler(conflict.value), (error: { status: number; code: string }) => error.status === 409 && error.code === 'preset_revision_conflict')
})

test('catalog and published revision derive creator from the authenticated administrator', async () => {
  const captured: unknown[] = []
  const resource = context({ readBody: async () => ({ id: 'resource-1', createdBy: 'forged-user' }), resources: { createResource: (value: unknown) => { captured.push(value); return value } } })
  await route('POST', '/resources').handler(resource.value)
  assert.deepEqual(captured[0], { id: 'resource-1', createdBy: 'user-1' })
  const revision = context({ params: { resourceId: 'resource-1' }, readBody: async () => ({ resourceId: 'resource-1', createdBy: 'forged-user' }), resources: { createRevision: (value: unknown) => { captured.push(value); return value } } })
  await route('POST', '/resources/:resourceId/revisions').handler(revision.value)
  assert.deepEqual(captured[1], { resourceId: 'resource-1', createdBy: 'user-1' })
})

test('provider routes reject inline secrets before calling the catalog and reject unmapped bindings', async () => {
  const definition = { providerKey: 'openai-compatible', endpoint: 'https://models.example.test/v1', modelIds: ['test-model'], agentKeys: ['pi'], credential: { kind: 'environment', variableNames: ['OPENAI_API_KEY'] } }
  const create = context({ readBody: async () => ({ id: 'provider-1', kind: 'model-provider', name: 'test', description: '', definition: { ...definition, apiKey: 'sentinel-secret' } }), resources: { createResource: () => { throw new Error('must_not_write_secret') } } })
  await assert.rejects(async () => route('POST', '/resources').handler(create.value), (error: { status: number; code: string }) => error.status === 400 && error.code === 'invalid_provider_config')
  const unknown = context({ readBody: async () => ({ id: 'provider-1', kind: 'model-provider', name: 'test', description: '', definition, token: 'sentinel-secret' }), resources: { createResource: () => { throw new Error('must_not_write_secret') } } })
  await assert.rejects(async () => route('POST', '/resources').handler(unknown.value), (error: { status: number; code: string }) => error.status === 400 && error.code === 'invalid_provider_config')
  const patched = context({ params: { resourceId: 'provider-1' }, readBody: async () => ({ id: 'provider-1', kind: 'model-provider', name: 'test', description: '', definition, createdAt: '2026-01-01', updatedAt: '2026-01-01', token: 'sentinel-secret' }), resources: { updateResource: () => { throw new Error('must_not_write_secret') } } })
  await assert.rejects(async () => route('PATCH', '/resources/:resourceId').handler(patched.value), (error: { status: number; code: string }) => error.status === 400 && error.code === 'invalid_provider_config')
  const binding = context({ readBody: async () => ({ workerId: 'worker-1', resourceRevisionId: 'provider-rev', agentKey: 'claude-code' }), resources: { createBinding: () => { throw new Error('invalid_provider_binding') } } })
  await assert.rejects(async () => route('POST', '/resource-bindings').handler(binding.value), (error: { status: number; code: string }) => error.status === 400 && error.code === 'invalid_provider_binding')
})

test('binding route derives creator from the authenticated administrator', async () => {
  let received: unknown
  const fixture = context({
    readBody: async () => ({ id: 'binding-1', workerId: 'worker-1', resourceRevisionId: 'revision-1' }),
    resources: {
      createBinding: (value: unknown) => { received = value; return value },
    },
  })
  await route('POST', '/resource-bindings').handler(fixture.value)
  assert.deepEqual(received, { id: 'binding-1', workerId: 'worker-1', resourceRevisionId: 'revision-1', agentKey: null, projectId: null, createdBy: 'user-1' })
  assert.equal(fixture.output.status, 201)
})
