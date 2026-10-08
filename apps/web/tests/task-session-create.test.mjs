import test from 'node:test'
import assert from 'node:assert/strict'
import { createApi } from '../src/api/client.ts'
import { PendingTaskSession } from '@wemux/web-client'
import { createIndependentTaskSession } from '../src/features/tasks/task-session-create.ts'

test('legacy caller through real Api freezes assignee and advertised model across lost response and refresh', async () => {
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch
  const map = new Map(), storage = { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) }
  globalThis.window = { location: { origin: 'http://legacy.test' }, localStorage: storage }
  const calls = []; let lose = true, models = ['first', 'second']
  globalThis.fetch = async (url, init) => {
    if (url.pathname === '/api/workers') return Response.json({ items: [{ id: 'worker', capabilities: [{ agentKey: 'test', models: models.map(modelId => ({ modelId })) }] }] })
    if (url.pathname === '/api/workers/worker/capabilities') return Response.json({ workerId: 'worker', capabilities: [{ agentKey: 'test', models: models.map(modelId => ({ modelId })) }] })
    const body = JSON.parse(init.body); calls.push(body)
    if (lose) throw Error('committed but response lost')
    return Response.json({ session: { id: 'session', projectId: 'p', taskId: 't', runId: null, ownerId: 'owner', workspaceId: 'w', title: body.title, binding: { workspaceId: 'w', agent: { workerId: 'worker', agentKey: 'test' }, modelId: body.modelId }, shareScope: 'project', runtimeState: 'idle', deletedAt: null, creation: { requestId: body.requestId, commandId: 'command', fingerprint: 'fp' } }, commandId: 'command', created: false })
  }
  try {
    const api = createApi({ username: 'owner', teamId: 'team', csrfToken: '', email: null, instanceAdministrator: false })
    const scope = { ...api.taskSessionScope, projectId: 'p', taskId: 't' }
    const task = { projectId: 'p', id: 't', title: 'Original', assignee: { workspaceId: 'w', workerId: 'worker', agentKey: 'test', modelId: null } }
    const pending = new PendingTaskSession(() => storage, scope, () => 'stable')
    const one = createIndependentTaskSession(pending, api, task), two = createIndependentTaskSession(pending, api, task)
    assert.equal(one, two)
    await assert.rejects(one)
    assert.deepEqual(calls[0], { requestId: 'stable', title: 'Original', workspaceId: 'w', workerId: 'worker', agentKey: 'test', modelId: 'first' })
    task.title = 'Changed'; task.assignee = null; models.reverse(); lose = false
    const result = await createIndependentTaskSession(new PendingTaskSession(() => storage, scope), api, task)
    assert.deepEqual(calls[1], calls[0]); assert.equal(result.session.id, 'session'); assert.equal(result.commandId, 'command')
    assert.equal(pending.read(), null)
    api.dispose()
  } finally { globalThis.window = oldWindow; globalThis.fetch = oldFetch }
})
