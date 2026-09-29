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

  const desired = context({ params: { workerId: 'worker-1' } })
  await route('GET', '/workers/:workerId/resource-set').handler(desired.value)
  assert.deepEqual(desired.output.body, { workerId: 'worker-1', revision: 1, bindings: [] })
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
