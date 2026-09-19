import test from 'node:test'
import assert from 'node:assert/strict'
import { initialQuickConfig, fillQuickChoices, quickConfigReason, QuickStartController } from '../features/sessions/quick-start.ts'
import { projectJournal } from './journal.ts'
import { createApi } from './client.ts'

const agent = { agentKey: 'pi', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' }] }
const workers = ['a', 'b'].map(id => ({ id, connectionState: 'online', capabilities: [agent] }))
const placement = workerId => ({ workerId, status: 'ready', failureReason: null, location: null })
const workspace = { id: 'w', projectId: 'p', workerId: 'a', status: 'failed', placements: [placement('a'), placement('b')] }
const config = { workspaceId: 'w', workerId: 'b', agentKey: 'pi', modelId: 'model' }

test('multi-placement default is explicit, secondary readiness overrides legacy primary, stale choices stay stale', () => {
  assert.deepEqual(initialQuickConfig('p', [workspace], workers, null), { workspaceId: 'w', workerId: '', agentKey: '', modelId: '' })
  assert.equal(quickConfigReason(config, 'p', [workspace], workers), '')
  assert.deepEqual(fillQuickChoices({ ...config, agentKey: '', modelId: '' }, 'p', [workspace], workers), config)
  const stale = { ...config, workerId: 'gone' }
  assert.deepEqual(initialQuickConfig('p', [workspace], workers, stale), stale)
  assert.match(quickConfigReason(stale, 'p', [workspace], workers), /落点已不存在/)
  assert.equal(quickConfigReason(config, 'p', [{ ...workspace, placements: [{ ...placement('b'), status: 'failed', failureReason: '磁盘不足' }] }], workers), '磁盘不足')
  assert.equal(quickConfigReason(config, 'p', [workspace], workers.map(w => ({ ...w, capabilities: [{ ...agent, availability: { status: 'unavailable', reason: '请登录' } }] }))), '请登录')
  assert.deepEqual(initialQuickConfig('p', [{ ...workspace, placements: [placement('b')] }], workers, null), config)
})

test('quick start transmits selected worker and retains identity on lost create response', async () => {
  const stored = new Map(), storage = { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v), removeItem: k => stored.delete(k) }
  const requests = []
  const api = { workspaces: async () => [workspace], workers: async () => workers, createSession: async body => { requests.push(body); if (requests.length === 1) throw new Error('lost'); return { id: 's' } }, session: async () => ({ id: 's', projectId: 'p', ...config, sendCapability: { allowed: true } }), send: async (_, body) => ({ ...body, status: 'accepted' }) }
  const controller = new QuickStartController(api, 'p', 'key', config, storage, storage)
  controller.edit('你好')
  await controller.start()
  assert.match(controller.state.error, /requestId/)
  await controller.start()
  assert.equal(requests[0].workerId, 'b')
  assert.deepEqual(requests[0], requests[1])
  assert.equal(controller.state.completed, 's')
  controller.dispose()
})

const events = payloads => payloads.map((payload, i) => ({ sessionId: 's', seq: i + 1, payload }))
test('journal exposes queue identities, active turn, approvals and terminal cleanup', () => {
  const initial = [
    { kind: 'message.queued', commandId: 'c1', messageId: 'm1', content: 'one', position: 0 },
    { kind: 'message.queued', commandId: 'c2', messageId: 'm2', content: 'two', position: 1 },
    { kind: 'turn.started', turnId: 't', messageId: 'm1' },
    { kind: 'approval.requested', turnId: 't', approvalId: 'a', action: { tool: 'shell' }, reason: '确认执行' },
  ]
  const active = projectJournal(events(initial))
  assert.equal(active.activeTurnId, 't')
  assert.equal(active.queuedItems[0].commandId, 'c2')
  assert.equal(active.pendingApprovals[0].approvalId, 'a')
  assert.equal(projectJournal(events([...initial, { kind: 'approval.resolved', approvalId: 'a', decision: 'deny' }])).pendingApprovals.length, 0)
  const terminal = projectJournal(events([...initial, { kind: 'message.cancelled', commandId: 'c2', messageId: 'm2' }, { kind: 'turn.finished', turnId: 't', outcome: 'cancelled', failure: null }]))
  assert.equal(terminal.activeTurnId, null)
  assert.deepEqual(terminal.queuedItems, [])
  assert.deepEqual(terminal.pendingApprovals, [])
  assert.equal(terminal.messages.find(m => m.id === 'm1').status, 'cancelled')
})

test('cluster request methods encode identities and preserve control payloads', async () => {
  const previousFetch = globalThis.fetch, previousWindow = globalThis.window
  const calls = []
  globalThis.window = { location: { origin: 'http://localhost' } }
  globalThis.fetch = async (url, options) => {
    calls.push({ path: url.pathname, method: options.method, body: JSON.parse(options.body) })
    return Response.json(options.method === 'PATCH' ? { id: 's', title: '改名', binding: { agent: { workerId: 'b', agentKey: 'pi' }, modelId: 'model' } } : { commandId: 'c' })
  }
  const api = createApi({ token: 'token', teamId: '' })
  try {
    await api.stopTurn('s/x', 't/x', 'c')
    await api.cancelQueued('s/x', 'submission/x', 'c')
    await api.invokeRuntimeCommand('s/x', { commandId: 'c', operationId: 'op', name: 'compact' })
    await api.resolveApproval('s/x', 'a/x', { commandId: 'c', decision: 'deny' })
    assert.equal((await api.renameSession('s/x', '改名')).title, '改名')
    assert.deepEqual(calls.map(c => [c.path, c.method]), [
      ['/api/sessions/s%2Fx/turn/stop', 'POST'], ['/api/sessions/s%2Fx/messages/submission%2Fx/cancel', 'POST'],
      ['/api/sessions/s%2Fx/runtime/commands', 'POST'], ['/api/sessions/s%2Fx/runtime/approvals/a%2Fx', 'POST'], ['/api/sessions/s%2Fx', 'PATCH'],
    ])
    assert.deepEqual(calls[0].body, { commandId: 'c', turnId: 't/x' })
    assert.deepEqual(calls[1].body, { commandId: 'c' })
    assert.deepEqual(calls[2].body, { commandId: 'c', operationId: 'op', name: 'compact' })
    assert.deepEqual(calls[3].body, { commandId: 'c', decision: 'deny' })
  } finally { api.dispose(); globalThis.fetch = previousFetch; globalThis.window = previousWindow }
})
