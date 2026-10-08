import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversationControls } from '@wemux/web-client'
import { conversationControlBinding } from '../src/lib/conversation-control-port.ts'
const scope = { host: 'http://fixture.test', accountId: 'server-id', teamId: 't', projectId: 'p', taskId: 'task', sessionId: 's' }
const intent = { operation: 'stop-turn', body: { commandId: 'original', turnId: 'old-turn' } }
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
 const abort = new AbortController(), calls = []; let release
 const api = { taskSessionScope: { host: scope.host, account: 'username', teamId: 't' }, controlIdentity: { accountId: scope.accountId, signal: abort.signal }, selectModel: async () => { throw Error('unused') }, resolveApproval: async () => { throw Error('unused') }, cancelQueuedMessage: async () => { throw Error('unused') }, stopTurn: async (session, body) => { calls.push({ session, body }); await new Promise(resolve => { release = resolve }); return { commandId: body.commandId } } }
 const snapshot = { scope: { ...scope, accountId: 'username' }, status: 'ready', subscription: 'watching', needsRefresh: false, session: { id: 's', taskId: 'task', projectId: 'p', workspaceId: 'w', binding: { workspaceId: 'w', agent: { workerId: 'node', agentKey: 'agent' } }, access: { canRead: true, canWrite: true, canControl: true }, activeTurnId: 'old-turn', activeTurnOwnerId: scope.accountId, queuedMessages: [] } }
 const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, read = { getSnapshot: () => snapshot }
 return { api, abort, snapshot, storage, read, calls, release: () => release() }
}
test('Strict Mode effect replay/remount is read-only and explicit same-port retry joins one original flight', async () => {
 const f = fixture(), binding = conversationControlBinding(f.api, scope)
 const mount = () => { const detach = binding.attach(f.read), controller = createConversationControls(scope, { storage: () => f.storage, port: binding.port }); controller.load(); return { controller, dispose() { detach(); controller.dispose() } } }
 const replay = mount(); replay.dispose(); const first = mount(); assert.equal(f.calls.length, 0)
 const sending = first.controller.submit(intent); await tick(); first.dispose()
 const second = mount(); assert.equal(f.calls.length, 1); const retry = second.controller.retry(); await tick(); assert.equal(f.calls.length, 1)
 f.snapshot.session.activeTurnId = 'new-turn'; f.release(); await Promise.all([sending, retry])
 assert.deepEqual(f.calls[0], { session: 's', body: intent.body }); assert.equal(second.controller.getSnapshot().status, 'admitted'); second.dispose()
})
test('view detach retires read authority without aborting client; old response cannot settle durable slot', async () => {
 const f = fixture(), binding = conversationControlBinding(f.api, scope), detach = binding.attach(f.read)
 const controller = createConversationControls(scope, { storage: () => f.storage, port: binding.port }); controller.load()
 const pending = controller.submit(intent); await tick(); detach(); controller.dispose(); f.release(); await pending; await tick()
 assert.equal(f.abort.signal.aborted, false); assert.equal(JSON.parse(f.storage.getItem(controller.key)).receipt, null)
})
test('true client disposal refuses late receipt; different port cannot adopt old admission to mint replacement', async () => {
 const f = fixture(), binding = conversationControlBinding(f.api, scope); binding.attach(f.read)
 const first = createConversationControls(scope, { storage: () => f.storage, port: binding.port }); first.load(); const pending = first.submit(intent); await tick()
 f.abort.abort(); f.release(); await pending
 assert.equal(JSON.parse(f.storage.getItem(first.key)).receipt, null)
 const next = fixture(), port = conversationControlBinding(next.api, scope); port.attach(next.read)
 const second = createConversationControls(scope, { storage: () => f.storage, port: port.port }); second.load()
 await second.submit({ operation: 'stop-turn', body: { commandId: 'replacement', turnId: 'next-turn' } })
 assert.equal(next.calls.length, 0); assert.equal(JSON.parse(f.storage.getItem(first.key)).intent.body.commandId, 'original')
})
test('permission loss before settlement and retry never borrows stale controller ownership', async () => {
 const f = fixture(), binding = conversationControlBinding(f.api, scope); binding.attach(f.read)
 const controller = createConversationControls(scope, { storage: () => f.storage, port: binding.port }); controller.load(); const pending = controller.submit(intent); await tick()
 f.snapshot.session.access.canWrite = false; f.release(); await pending; assert.equal(JSON.parse(f.storage.getItem(controller.key)).receipt, null)
 controller.load(); await controller.retry(); assert.equal(f.calls.length, 1)
})
