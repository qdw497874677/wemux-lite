import test from 'node:test'
import assert from 'node:assert/strict'
import * as target from './legacy-test-target.mjs'

const project = { id: 'project/one' }
const worker = { id: 'worker', connectionState: 'online' }
const workspace = { id: 'workspace/one', projectId: project.id, placements: [{ workerId: worker.id, status: 'ready' }] }
const prefix = '/api/projects/project%2Fone/tasks'
const summary = id => ({ id, projectId: project.id, status: 'done', assignee: null })
const binding = (taskId, workspaceId = workspace.id) => ({ taskId, projectId: project.id, workspaceId, createdAt: '2026-01-01T00:00:00.000Z' })

function fixture(overrides = {}) {
  const calls = []
  const responses = {
    '/api/workspaces?projectId=project%2Fone': { items: [workspace] },
    [prefix]: { items: [summary('old/task'), summary('other')] },
    [`${prefix}/old%2Ftask/workspaces`]: { items: [] },
    [`${prefix}/other/workspaces`]: { items: [] },
    '/api/workers/worker/capabilities': { capabilities: [{ agentKey: 'test', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'echo' }] }] },
    ...overrides,
  }
  const request = async (path, method = 'GET') => {
    calls.push({ path, method })
    assert.equal(method, 'GET', 'preflight must not write')
    assert.ok(Object.hasOwn(responses, path), 'only documented public routes')
    const value = responses[path]
    if (value instanceof Error) throw value
    return value
  }
  return { calls, request, projects: [project], workers: [worker] }
}

test('already-bound ready Workspace is excluded even for done Task with null assignee', async () => {
  const api = fixture({ [`${prefix}/old%2Ftask/workspaces`]: { items: [binding('old/task')] } })
  assert.equal((await target.findSafeTestAgentTarget(api)).selection, undefined)
  assert.ok(api.calls.some(call => call.path === `${prefix}/old%2Ftask/workspaces`))
  assert.ok(api.calls.every(call => !call.path.endsWith('/capabilities')))
})

test('only full successful authorized Task binding enumeration permits a candidate; unrelated bindings do not exclude it', async () => {
  const api = fixture({ [`${prefix}/old%2Ftask/workspaces`]: { items: [binding('old/task', 'other-workspace')] } })
  assert.equal((await target.findSafeTestAgentTarget(api)).selection.workspace.id, workspace.id)
  assert.deepEqual(api.calls.map(call => call.path), [
    '/api/workspaces?projectId=project%2Fone', prefix,
    `${prefix}/old%2Ftask/workspaces`, `${prefix}/other/workspaces`, '/api/workers/worker/capabilities',
  ])
})

test('missing/forbidden/failed binding reads are never interpreted as unbound', async () => {
  for (const path of [prefix, `${prefix}/other/workspaces`]) {
    for (const status of [401, 403, 404, 500, undefined]) {
      const failure = Object.assign(Error('private server text'), { status })
      const api = fixture({ [path]: failure })
      await assert.rejects(target.findSafeTestAgentTarget(api), error => error === failure)
      assert.ok(api.calls.every(call => !call.path.endsWith('/capabilities')))
    }
  }
})

test('malformed, partial or foreign Task/binding views fail closed rather than guessing absence', async () => {
  const invalidViews = [
    [prefix, null], [prefix, {}], [prefix, { items: null }],
    [prefix, { items: [], nextCursor: 'more' }],
    [prefix, { items: [{ id: 'old/task' }] }],
    [prefix, { items: [{ ...summary('old/task'), projectId: 'foreign' }] }],
    [prefix, { items: [summary('old/task'), summary('old/task')] }],
    [`${prefix}/other/workspaces`, {}],
    [`${prefix}/other/workspaces`, { items: null }],
    [`${prefix}/other/workspaces`, { items: [null] }],
    [`${prefix}/other/workspaces`, { items: [{ workspaceId: workspace.id }] }],
    [`${prefix}/other/workspaces`, { items: [{ ...binding('other'), projectId: 'foreign' }] }],
    [`${prefix}/other/workspaces`, { items: [binding('wrong-task')] }],
    [`${prefix}/other/workspaces`, { items: [{ ...binding('other'), workspaceId: '' }] }],
    [`${prefix}/other/workspaces`, { items: [{ ...binding('other'), createdAt: undefined }] }],
  ]
  for (const [path, value] of invalidViews) {
    await assert.rejects(target.findSafeTestAgentTarget(fixture({ [path]: value })), /binding preflight unavailable/)
  }
})

test('known binding does not hide a later failed enumeration request', async () => {
  const failure = Error('forbidden')
  const api = fixture({ [`${prefix}/old%2Ftask/workspaces`]: { items: [binding('old/task')] }, [`${prefix}/other/workspaces`]: failure })
  await assert.rejects(target.findSafeTestAgentTarget(api), error => error === failure)
})

for (const [failure, outcome] of [
  [Object.assign(Error('PRIVATE_SERVER_TEXT'), { status: 409, code: 'workspace_bound' }), 'workspace_bound'],
  [Object.assign(Error('PRIVATE_SERVER_TEXT'), { status: 403 }), 'binding-unconfirmed'],
  [Error('PRIVATE_SERVER_TEXT'), 'binding-unconfirmed'],
]) test(`post-create ${outcome} retains exact IDs and recovery before failing; no fallback write`, async () => {
  assert.equal(typeof target.createRetainedTestTask, 'function')
  const api = fixture()
  const { selection } = await target.findSafeTestAgentTarget(api)
  const events = [], records = []
  const request = async (path, method) => {
    events.push(method)
    if (method === 'POST') return { id: 'new/task', projectId: project.id, status: 'todo', version: 1 }
    assert.equal(path, `${prefix}/new%2Ftask/workspaces/workspace%2Fone`)
    assert.equal(method, 'PUT')
    assert.equal(records[0].taskId, 'new/task', 'exact ID durably recorded before bind attempt')
    throw failure
  }
  await assert.rejects(target.createRetainedTestTask({ selection, request, retain: async record => {
    events.push('persist'); records.push(structuredClone(record))
  } }), /binding not confirmed/)
  assert.deepEqual(events, ['POST', 'persist', 'PUT', 'persist'])
  const record = records.at(-1)
  assert.equal(record.projectId, project.id)
  assert.equal(record.taskId, 'new/task')
  assert.equal(record.workspaceId, workspace.id)
  assert.equal(record.workerId, worker.id)
  assert.equal(record.bindingOutcome, outcome)
  assert.equal(record.recovery.taskPath, `${prefix}/new%2Ftask`)
  assert.equal(record.recovery.bindingsPath, `${prefix}/new%2Ftask/workspaces`)
  assert.match(record.recovery.instructions, /manual authorization/)
  assert.match(record.recovery.instructions, /Do not automatically retry/)
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_SERVER_TEXT/)
})

test('private evidence persistence failure prevents bind; failure after bind still leaves the pending recovery record', async () => {
  assert.equal(typeof target.createRetainedTestTask, 'function')
  const { selection } = await target.findSafeTestAgentTarget(fixture())
  let puts = 0
  const failure = Error('disk unavailable')
  await assert.rejects(target.createRetainedTestTask({ selection,
    request: async (_path, method) => { if (method === 'PUT') puts++; return { id: 'new', projectId: project.id, status: 'todo' } },
    retain: async () => { throw failure },
  }), error => error === failure)
  assert.equal(puts, 0)
  const records = []
  await assert.rejects(target.createRetainedTestTask({ selection,
    request: async (_path, method) => { if (method === 'PUT') throw Error('network'); return { id: 'new', projectId: project.id, status: 'todo' } },
    retain: async record => { if (records.length) throw failure; records.push(structuredClone(record)) },
  }), error => error === failure)
  assert.equal(records[0].bindingOutcome, 'binding-pending')
  assert.match(records[0].recovery.instructions, /unknown/)
})

test('successful normal authorized bind is returned without assigning, launching, cleaning or retrying', async () => {
  assert.equal(typeof target.createRetainedTestTask, 'function')
  const { selection } = await target.findSafeTestAgentTarget(fixture())
  const methods = [], records = []
  const bound = { id: 'new', projectId: project.id, status: 'todo', workspaces: [binding('new')] }
  const result = await target.createRetainedTestTask({ selection,
    request: async (_path, method) => { methods.push(method); return method === 'POST' ? { ...bound, workspaces: [] } : bound },
    retain: async record => records.push(structuredClone(record)),
  })
  assert.deepEqual(methods, ['POST', 'PUT'])
  assert.equal(result.task, bound)
  assert.equal(result.retained.bindingOutcome, 'bound')
  assert.deepEqual(records.map(record => record.bindingOutcome), ['binding-pending', 'bound'])
})

test('public response adapter preserves only exact workspace_bound conflict classification, never error payload', async () => {
  for (const [status, code, expected] of [[409, 'workspace_bound', 'workspace_bound'], [403, 'workspace_bound', undefined], [500, 'PRIVATE_CODE', undefined]]) {
    await assert.rejects(target.readLegacyPublicResponse({ ok: () => false, status: () => status, json: async () => ({ error: { code, message: 'PRIVATE_MESSAGE', details: 'PRIVATE_DETAILS' } }) }), error => {
      assert.equal(error.message, 'public request rejected')
      assert.equal(error.status, status)
      assert.equal(error.code, expected)
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE/)
      return true
    })
  }
  await assert.rejects(target.readLegacyPublicResponse({ ok: () => false, status: () => 502, json: async () => { throw Error('PRIVATE_PARSE') } }), /public request rejected/)
  assert.equal(await target.readLegacyPublicResponse({ ok: () => true, status: () => 204 }), null)
  const body = { id: 'task' }
  assert.equal(await target.readLegacyPublicResponse({ ok: () => true, status: () => 201, json: async () => body }), body)
})
