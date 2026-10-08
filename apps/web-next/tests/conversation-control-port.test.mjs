import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationControlDenial, conversationControlBinding } from '../src/lib/conversation-control-port.ts'
const scope = { host: 'http://fixture.test', accountId: 'server-id', teamId: 't', projectId: 'p', taskId: 'task', sessionId: 's' }
const cancel = { operation: 'cancel-queued', submissionCommandId: 'enqueue', body: { commandId: 'cancel' } }
const stop = { operation: 'stop-turn', body: { commandId: 'stop', turnId: 'turn' } }
function fixture() {
 const abort = new AbortController(), calls = []
 const api = { taskSessionScope: { host: scope.host, account: 'display-name', teamId: 't' }, controlIdentity: { accountId: 'server-id', signal: abort.signal }, selectModel: async (...args) => { calls.push(args); return { commandId: args[1].commandId } }, resolveApproval: async (...args) => { calls.push(args); return { commandId: args[2].commandId } }, cancelQueuedMessage: async (...args) => { calls.push(args); return { commandId: args[2].commandId } }, stopTurn: async (...args) => { calls.push(args); return { commandId: args[1].commandId } } }
 let snapshot = { scope: { ...scope, accountId: 'display-name' }, status: 'ready', subscription: 'watching', needsRefresh: false, session: { id: 's', projectId: 'p', taskId: 'task', workspaceId: 'w', binding: { workspaceId: 'w', agent: { workerId: 'node', agentKey: 'agent' } }, access: { canRead: true, canWrite: true, canControl: false }, queuedMessages: [{ commandId: 'enqueue', messageId: 'message', sentByAccountId: 'server-id' }], activeTurnId: 'turn', activeTurnOwnerId: 'server-id' } }
 return { api, abort, calls, read: { getSnapshot: () => snapshot }, get snapshot() { return snapshot }, set snapshot(v) { snapshot = v } }
}
test('approval new target requires pending exact Turn, retry keeps original but rechecks authority', () => {
 const f = fixture(), approval = { operation: 'resolve-approval', approvalId: 'a', body: { commandId: 'decision', turnId: 'turn', decision: 'deny' } }
 f.snapshot.projection = { pendingApprovals: [{ approvalId: 'a', turnId: 'turn' }] }
 assert.equal(conversationControlDenial(f.api, scope, f.snapshot, approval, true), null)
 f.snapshot.projection.pendingApprovals = [{ approvalId: 'a', turnId: 'other' }]
 assert.ok(conversationControlDenial(f.api, scope, f.snapshot, approval, true))
 assert.equal(conversationControlDenial(f.api, scope, f.snapshot, approval, false), null)
 const binding = conversationControlBinding(f.api, scope), detach = binding.attach(f.read)
 binding.port.assertCurrent(scope, approval)
 f.snapshot.session.access.canWrite = false
 for (const fresh of [true, false]) assert.ok(conversationControlDenial(f.api, scope, f.snapshot, approval, fresh))
 assert.throws(() => binding.port.assertCurrent(scope, approval))
 f.snapshot.session.access.canWrite = true; detach(); assert.throws(() => binding.port.assertCurrent(scope, approval))
 binding.attach(f.read); f.abort.abort(); assert.throws(() => binding.port.assertCurrent(scope, approval))
})

test('model retry retains target while enforcing current write authority and scope', () => {
 const f = fixture(), intent = { operation: 'select-model', body: { commandId: 'model', modelId: 'next' } }
 for (const fresh of [true, false]) assert.equal(conversationControlDenial(f.api, scope, f.snapshot, intent, fresh), null)
 f.snapshot.session.access.canWrite = false
 for (const fresh of [true, false]) assert.ok(conversationControlDenial(f.api, scope, f.snapshot, intent, fresh))
 f.snapshot.session.access.canWrite = true; f.abort.abort()
 assert.ok(conversationControlDenial(f.api, scope, f.snapshot, intent, false))
})

test('control gate uses verified server identity, not username or sendCapability', () => {
 const f = fixture()
 for (const intent of [cancel, stop]) assert.equal(conversationControlDenial(f.api, scope, f.snapshot, intent, true), null)
 f.snapshot.session.queuedMessages[0].sentByAccountId = 'display-name'
 assert.ok(conversationControlDenial(f.api, scope, f.snapshot, cancel, true))
 f.snapshot.session.access.canControl = true
 assert.equal(conversationControlDenial(f.api, scope, f.snapshot, cancel, true), null)
 for (const accountId of ['', null, 'display-name']) assert.ok(conversationControlDenial({ ...f.api, controlIdentity: { ...f.api.controlIdentity, accountId } }, scope, f.snapshot, stop, true))
})
test('control gate denies readonly/archive/stale full scopes and missing current target', () => {
 for (const patch of [{ status: 'refreshing' }, { needsRefresh: true }, { error: {} }, { subscriptionError: {} }, { subscription: 'closed' }]) { const f = fixture(); assert.ok(conversationControlDenial(f.api, scope, { ...f.snapshot, ...patch }, cancel, true)) }
 for (const field of Object.keys(scope)) { const f = fixture(); assert.ok(conversationControlDenial(f.api, { ...scope, [field]: 'different' }, f.snapshot, cancel, true)) }
 for (const patch of [{ access: { canRead: false, canWrite: true, canControl: true } }, { access: { canRead: true, canWrite: false, canControl: true } }, { archivedAt: 'date' }, { deletedAt: 'date' }, { taskId: 'other' }]) { const f = fixture(); Object.assign(f.snapshot.session, patch); assert.ok(conversationControlDenial(f.api, scope, f.snapshot, stop, true)) }
})
test('original retry never follows a newer Turn; missing ownership denies while controller permission permits original retry', () => {
 const f = fixture(); f.snapshot.session.activeTurnId = 'next'; f.snapshot.session.queuedMessages = []
 assert.ok(conversationControlDenial(f.api, scope, f.snapshot, stop, false))
 f.snapshot.session.access.canControl = true
 for (const intent of [cancel, stop]) { assert.equal(conversationControlDenial(f.api, scope, f.snapshot, intent, false), null); assert.ok(conversationControlDenial(f.api, scope, f.snapshot, intent, true)) }
})
test('client owns stable normalized ports, detach leases cannot clear newer authority, disposal retires all ports', () => {
 const f = fixture(), binding = conversationControlBinding(f.api, scope)
 assert.equal(binding, conversationControlBinding(f.api, { ...scope, host: scope.host + '/' }))
 const detachOld = binding.attach(f.read), detachNew = binding.attach(f.read)
 detachOld(); binding.port.assertCurrent(scope, cancel)
 detachNew(); assert.throws(() => binding.port.assertCurrent(scope, cancel))
 const detach = binding.attach(f.read); binding.port.assertCurrent(scope, stop)
 f.snapshot.session.binding.agent.workerId = 'changed'; assert.throws(() => binding.port.assertCurrent(scope, stop))
 detach(); assert.equal(f.calls.length, 0)
 f.abort.abort(); assert.throws(() => binding.port.assertCurrent(scope, stop))
 assert.notEqual(binding, conversationControlBinding(fixture().api, scope))
})
