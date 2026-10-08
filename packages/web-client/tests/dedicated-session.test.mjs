import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterClient, PendingTaskSession } from '@wemux/web-client'
const scope = { host: 'http://host.test', account: 'owner', teamId: 'team', projectId: 'p', scenario: 'quick-chat' }
const body = { title: '试聊', workspaceId: 'w', workerId: 'worker', agentKey: 'test', modelId: 'model', requestId: 'r' }
const result = (created = true) => ({ created, commandId: 'c', session: { id: 's', projectId: 'p', taskId: 'dedicated-task', runId: null, ownerId: 'owner', workspaceId: 'w', title: '试聊', shareScope: 'owner-only', binding: { workspaceId: 'w', agent: { workerId: 'worker', agentKey: 'test' }, modelId: 'model' }, runtimeState: 'idle', deletedAt: null, creation: { requestId: 'r', commandId: 'c', fingerprint: 'fp' } } })
const client = fetcher => createClusterClient({ username: 'owner', teamId: 'team', csrfToken: 'csrf' }, () => {}, { origin: scope.host, fetcher })
test('dedicated creation uses root transport with explicit scenario and validates Task-bound private receipt', async () => {
  let call
  const api = client(async (url, init) => { call = { url, init }; return Response.json(result()) })
  assert.equal((await api.createDedicatedSession('p', 'quick-chat', body)).session.taskId, 'dedicated-task')
  assert.equal(call.url.pathname, '/api/sessions')
  assert.equal(call.init.headers['X-CSRF-Token'], 'csrf')
  assert.deepEqual(JSON.parse(call.init.body), { ...body, scenario: 'quick-chat' })
  for (const mutate of [r => { r.session.taskId = null }, r => { r.session.projectId = 'other' }, r => { r.session.shareScope = 'project' }, r => { r.session.binding.agent.workerId = 'other' }, r => { r.session.creation.requestId = 'other' }, r => { r.session.runId = 'run' }]) {
    const r = result(); mutate(r)
    await assert.rejects(client(async () => Response.json(r)).createDedicatedSession('p', 'agent-test', body), e => e.kind === 'contract')
  }
  const replay = result(false); replay.session.title = 'renamed'; replay.session.binding.modelId = 'new-model'
  assert.equal((await client(async () => Response.json(replay)).createDedicatedSession('p', 'quick-chat', body)).created, false)
  await assert.rejects(api.createDedicatedSession('p', 'quick-chat', { title: 'missing', requestId: 'r' }))
})
test('dedicated pending request survives refresh, isolates scenario/account/project and cannot collide with ordinary Task slots', async () => {
  const map = new Map(), storage = { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) }
  const pending = new PendingTaskSession(() => storage, scope, () => 'r')
  await assert.rejects(pending.run(() => body, async () => { throw Error('response lost') }))
  assert.deepEqual(pending.read(), body)
  for (const alternate of [{ ...scope, scenario: 'agent-test' }, { ...scope, account: 'other' }, { ...scope, projectId: 'other' }, { host: scope.host, account: scope.account, teamId: scope.teamId, projectId: scope.projectId, taskId: 'quick-chat' }]) assert.equal(new PendingTaskSession(() => storage, alternate).read(), null)
  const restored = new PendingTaskSession(() => storage, scope)
  await restored.run(() => { throw Error('must preserve intent') }, async saved => { assert.deepEqual(saved, body); return result(false) })
  assert.equal(restored.read(), null)
})
