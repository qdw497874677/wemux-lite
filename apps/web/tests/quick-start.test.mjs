import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { QuickStartController, fillQuickChoices, initialQuickConfig, quickConfigReason, quickKey, readPreference } from '../src/features/sessions/quick-start.ts'

const config = { workspaceId: 'w', workerId: 'worker', agentKey: 'pi', modelId: 'model' }
const readyPlacement = { workerId: 'worker', status: 'ready', failureReason: null, location: { rootPath: '/repo' } }
const workspace = { id: 'w', projectId: 'p', placements: [readyPlacement], workerId: 'worker', status: 'ready' }
const worker = { id: 'worker', connectionState: 'online', capabilities: [{ agentKey: 'pi', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' }] }] }
const session = { id: 's', projectId: 'p', ...config, sendCapability: { allowed: true } }
const memory = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) } }
function fixture(overrides = {}, storage = memory()) {
  const calls = { creates: [], sends: [] }
  const api = { workspaces: async () => [workspace], workers: async () => [worker], createSession: async body => { calls.creates.push(body); return session }, session: async () => session, command: async () => ({ status: 'pending', receipt: null }), send: async (id, body) => { calls.sends.push(body); return { ...body, status: 'accepted' } }, ...overrides }
  const preferences = memory()
  const controller = new QuickStartController(api, 'p', 'key', config, storage, preferences)
  controller.edit('first message')
  return { api, controller, calls, storage, preferences }
}
test('only unique valid environment defaults; saved stale identity is never replaced', () => {
  assert.deepEqual(initialQuickConfig('p', [workspace], [worker], null), config)
  assert.equal(initialQuickConfig('p', [workspace, { ...workspace, id: 'other' }], [worker], null).workspaceId, '')
  assert.equal(initialQuickConfig('p', [{ ...workspace, projectId: 'elsewhere' }], [worker], null).workspaceId, '')
  assert.equal(initialQuickConfig('p', [workspace, { ...workspace, id: 'offline-choice', status: 'failed' }], [worker], null).workspaceId, '')
  const stale = { ...config, modelId: 'removed' }
  assert.deepEqual(initialQuickConfig('p', [workspace], [worker], stale), stale)
  assert.match(quickConfigReason(stale, 'p', [workspace], [worker]), /原模型/)
  assert.match(quickConfigReason(config, 'p', [workspace], [{ ...worker, connectionState: 'offline' }]), /不在线/)
  assert.match(quickConfigReason(config, 'p', [workspace], [{ ...worker, capabilities: [{ ...worker.capabilities[0], availability: { status: 'authentication-required', reason: '登录失效' } }] }]), /登录失效/)
})
test('preferences are project and authenticated server scope isolated, tolerate corrupt storage', () => {
  assert.notEqual(quickKey('server-A/user-A', 'p'), quickKey('server-B/user-A', 'p'))
  assert.notEqual(quickKey('server-A/user-A', 'p'), quickKey('server-A/user-B', 'p'))
  assert.notEqual(quickKey('scope', 'p'), quickKey('scope', 'other'))
  assert.equal(readPreference({ getItem: () => 'oops' }, 'key'), null)
})
test('double submit creates and sends once, remembers only acknowledged configuration', async () => {
  const f = fixture()
  const first = f.controller.start(), second = f.controller.start()
  assert.equal(await second, null)
  assert.equal(await first, 's')
  assert.equal(f.calls.creates.length, 1); assert.equal(f.calls.sends.length, 1)
  assert.equal(f.controller.state.draft, '')
  assert.deepEqual(readPreference(f.preferences, 'key'), config)
  assert.equal(await f.controller.start(), null)
  assert.equal(f.calls.creates[0].workerId, 'worker')
})
test('lost create response retries one durable requestId and resumes the same Session after reload', async () => {
  const requests = []
  const f = fixture({ createSession: async body => { requests.push(body); if (requests.length === 1) throw new Error('lost response'); return session } })
  await f.controller.start()
  const restored = new QuickStartController(f.api, 'p', 'key', config, f.storage, f.preferences)
  assert.equal(await restored.start(), 's')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].requestId, requests[1].requestId)
  assert.equal(restored.state.draft, '')
  assert.deepEqual(readPreference(f.preferences, 'key'), config)
})
test('explicit create rejection permits corrected retry without clearing draft', async () => {
  let count = 0
  const f = fixture({ createSession: async () => { if (++count === 1) throw Object.assign(new Error('unavailable'), { status: 409 }); return session } })
  await f.controller.start()
  assert.equal(f.controller.state.attempt, null); assert.equal(f.controller.state.draft, 'first message')
  assert.equal(await f.controller.start(), 's'); assert.equal(count, 2)
})
test('send failure resumes same Session and exact payload after reload; edits cannot change uncertain intent', async () => {
  const sent = []
  const f = fixture({ send: async (id, body) => { sent.push({ id, body }); if (sent.length === 1) throw new Error('timeout'); return { ...body, status: 'accepted' } } })
  assert.equal(await f.controller.start(), 's')
  assert.equal(f.controller.state.draft, 'first message')
  f.controller.edit('different'); f.controller.configure({ ...config, workspaceId: 'different' })
  assert.equal(f.controller.state.draft, 'first message'); assert.deepEqual(f.controller.state.config, config)
  f.controller.dispose()
  const restored = new QuickStartController(f.api, 'p', 'key', config, f.storage, f.preferences)
  assert.equal(await restored.start(), 's')
  assert.equal(f.calls.creates.length, 1); assert.deepEqual(sent[0], sent[1])
})
test('fresh validation and authoritative capability stop creation/send without losing draft', async () => {
  const f = fixture({ workers: async () => [{ ...worker, connectionState: 'offline' }] })
  await f.controller.start(); assert.equal(f.calls.creates.length, 0); assert.equal(f.controller.state.draft, 'first message')
  const blocked = fixture({ session: async () => ({ ...session, sendCapability: { allowed: false, reason: 'blocked' } }) })
  await blocked.controller.start(); assert.equal(blocked.calls.sends.length, 0); assert.equal(blocked.controller.state.attempt.sessionId, 's')
  assert.match(blocked.controller.state.error, /blocked/)
})
test('durable intent storage failure prevents non-idempotent creation', async () => {
  const f = fixture({}, { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem() {} })
  await f.controller.start(); assert.equal(f.calls.creates.length, 0); assert.equal(f.controller.state.draft, 'first message')
})
test('connection disposal during create never proceeds to send', async () => {
  let resolve
  const f = fixture({ createSession: () => new Promise(r => { resolve = r }) })
  const start = f.controller.start()
  await new Promise(r => setImmediate(r)); f.controller.dispose(); resolve(session); await start
  assert.equal(f.calls.sends.length, 0)
})
test('quick entry reuses session contracts without Task or Run prerequisite; mobile conversation geometry preserved', () => {
  const src = path => readFileSync(new URL(path, import.meta.url), 'utf8')
  const controller = src('../src/features/sessions/quick-start.ts')
  assert.doesNotMatch(controller, /api\.(createTask|launch|assignTask)/)
  const app = src('../src/App.tsx')
  assert.match(app, /<QuickConversation/)
  assert.match(app, /onProject=\{id => go\(`\/projects\/\$\{encodeURIComponent\(id\)\}\/sessions`\)\}/)
  assert.match(app, /<SidebarProvider>/)
  assert.doesNotMatch(app, /conversation-focus/)
  assert.match(app, /go\(`\$\{projectBase\}\/sessions`\)\}>返回/)
  const ui = src('../src/components/quick-conversation.tsx')
  assert.ok(ui.indexOf('aria-label="对话配置"') < ui.indexOf('aria-label="首条消息"'))
  assert.match(ui, /<PromptInput/); assert.match(ui, /onSetup/); assert.match(ui, /readOnly=\{locked\}/)
  assert.match(ui, /运行时诊断/); assert.match(ui, /查看详情/)
  assert.doesNotMatch(ui, /<fieldset/)
  assert.doesNotMatch(ui, /Boolean\(state.attempt && !state.attempt.sessionId\)/)
  assert.match(src('../src/styles.css'), /--chat-max-width: 45rem/)
  assert.match(src('../src/styles.css'), /max-width: var\(--chat-max-width\)/)
})

test('pending enqueue preserves first content until Worker acknowledgement, including reload', async () => {
  const f = fixture({ send: async (_id, body) => ({ ...body, status: 'pending' }) })
  assert.equal(await f.controller.start(), 's')
  assert.equal(f.controller.state.completed, null)
  assert.equal(f.controller.state.draft, 'first message')
  f.controller.dispose()
  const restored = new QuickStartController({ ...f.api, command: async () => ({ status: 'rejected', receipt: { error: { message: 'Worker unavailable' } } }) }, 'p', 'key', config, f.storage, f.preferences)
  await restored.checkReceipt()
  assert.equal(restored.state.completed, null)
  assert.equal(restored.state.draft, 'first message')
  assert.equal(restored.state.attempt.rejected, true)
  assert.match(restored.state.error, /Worker unavailable/)
  restored.dispose()
})
test('confirmed terminal reject gets fresh message IDs on same Session only on explicit retry', async () => {
  const bodies = []
  const f = fixture({ send: async (id, body) => { bodies.push({ id, ...body }); return { ...body, status: bodies.length === 1 ? 'rejected' : 'accepted' } } })
  await f.controller.start()
  assert.equal(f.controller.state.attempt.rejected, true)
  await f.controller.start()
  assert.equal(f.calls.creates.length, 1)
  assert.equal(bodies[0].id, bodies[1].id)
  assert.notEqual(bodies[0].commandId, bodies[1].commandId)
  assert.notEqual(bodies[0].messageId, bodies[1].messageId)
})
test('create retry preserves complete frozen request and does not expose manual Session recovery', async () => {
  const requests = []
  const f = fixture({ createSession: async body => { requests.push(body); if (requests.length === 1) throw new Error('lost'); return session } })
  await f.controller.start()
  f.controller.edit('changed'); f.controller.configure({ ...config, modelId: 'changed' })
  await f.controller.start()
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1], requests[0])
  const ui = readFileSync(new URL('../src/components/quick-conversation.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(ui, / ID|attachExisting|abandonUnknown/)
})

test('explicit upstream choices fill only unique valid blank downstream choices', () => {
  assert.deepEqual(fillQuickChoices({ ...config, agentKey: '', modelId: '' }, 'p', [workspace], [worker]), config)
  const multi = { ...worker, capabilities: [...worker.capabilities, { ...worker.capabilities[0], agentKey: 'other' }] }
  assert.equal(fillQuickChoices({ ...config, agentKey: '', modelId: '' }, 'p', [workspace], [multi]).agentKey, '')
  assert.equal(fillQuickChoices({ ...config, modelId: '' }, 'p', [workspace], [multi]).modelId, 'model')
  const stale = { ...config, modelId: 'gone' }
  assert.deepEqual(fillQuickChoices(stale, 'p', [workspace], [worker]), stale)
  assert.equal(fillQuickChoices({ ...config, agentKey: '', modelId: '' }, 'p', [workspace], [{ ...worker, connectionState: 'offline' }]).agentKey, '')
})
test('pending acknowledgement alone completes and persists preference, not enqueue', async () => {
  let status = 'pending'
  const f = fixture({ send: async (_id, body) => ({ ...body, status: 'pending' }), command: async () => ({ status, receipt: null }) })
  await f.controller.start()
  await new Promise(r => setImmediate(r))
  assert.equal(readPreference(f.preferences, 'key'), null)
  status = 'accepted'
  await f.controller.checkReceipt()
  assert.equal(f.controller.state.completed, 's')
  assert.equal(f.controller.state.draft, '')
  assert.deepEqual(readPreference(f.preferences, 'key'), config)
  f.controller.dispose()
})
test('quick UI keeps mobile workspaces visible, exact select names and stale navigation guards', () => {
  const src = path => readFileSync(new URL(path, import.meta.url), 'utf8')
  const ui = src('../src/components/quick-conversation.tsx')
  for (const label of ['工作区', '节点', '智能体', '模型']) assert.ok(ui.includes(`label="${label}"`))
  assert.match(ui, /<ConfigChip/)
  assert.match(ui, /return \(\) => \{ viewGeneration.current\+\+ \}/)
  assert.match(ui, /id && generation === viewGeneration.current/)
  assert.match(src('../src/App.tsx'), /key=\{`\$\{projectId\}:\$\{section\}`\}/)
  assert.match(src('../src/App.tsx'), /<QuickStartRecovery/)
  const nav = src('../src/components/project-quick-nav.tsx')
  assert.match(nav, /projectNavigationItems\.map/)
  assert.match(src('../src/components/navigation-items.ts'), /path: 'workspaces'.*shortLabel: '工作区'/)
  assert.doesNotMatch(src('../src/components/project-session-list.tsx'), /点击“新建会话”/)
})

test('legacy pending-as-completed records recover retained payload and observe receipt', async () => {
  const storage = memory()
  storage.setItem('key', JSON.stringify({ config, draft: '', completed: 's', attempt: { config, title: 'first', sessionId: 's', message: { content: 'first message', commandId: 'old-command', messageId: 'old-message' } } }))
  const f = fixture({ command: async () => ({ status: 'rejected', receipt: null }) }, storage)
  assert.equal(f.controller.state.completed, null)
  assert.equal(f.controller.state.draft, 'first message')
  await f.controller.checkReceipt()
  assert.equal(f.controller.state.attempt.rejected, true)
  assert.equal(f.calls.sends.length, 0)
  f.controller.dispose()
})
test('HTTP confirmed rejection rotates IDs but a timeout never does', async () => {
  const bodies = []
  const f = fixture({ send: async (_id, body) => { bodies.push(body); if (bodies.length === 1) throw Object.assign(new Error('denied'), { status: 409 }); return { ...body, status: 'accepted' } } })
  await f.controller.start()
  assert.equal(f.controller.state.attempt.rejected, true)
  await f.controller.start()
  assert.notEqual(bodies[0].commandId, bodies[1].commandId)
  assert.equal(f.calls.creates.length, 1)
})
