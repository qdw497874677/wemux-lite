import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationSendDenial } from '../src/lib/conversation-send-gate.ts'
const scope = { accountId: 'a', teamId: 't', projectId: 'p', taskId: 'task', sessionId: 's' }
const ready = () => ({ scope, status: 'ready', needsRefresh: false, error: null, subscriptionError: null, subscription: 'watching', session: { id: 's', projectId: 'p', taskId: 'task', deletedAt: null, archivedAt: null, access: { canRead: true, canWrite: true }, sendCapability: { allowed: true, reasonCode: 'allowed', reason: '' }, freshness: { status: 'offline' } } })
test('conversation send gate trusts explicit capability, not Journal offline or local receipt', () => {
  assert.equal(conversationSendDenial(ready(), { ...scope, host: 'http://fixture.test' }), null)
  assert.ok(conversationSendDenial(null, scope))
  for (const patch of [{ status: 'loading' }, { status: 'refreshing' }, { status: 'blocked' }, { needsRefresh: true }, { error: {} }, { subscriptionError: {} }, { subscription: 'closed' }]) assert.ok(conversationSendDenial({ ...ready(), ...patch }, scope))
})
test('conversation send gate fixes all scope fields and denies unavailable/read-only/archived/deleted capability', () => {
  for (const key of Object.keys(scope)) assert.ok(conversationSendDenial(ready(), { ...scope, [key]: 'different' }))
  for (const patch of [{ taskId: 'other' }, { projectId: 'other' }, { id: 'other' }, { access: { canRead: true, canWrite: false } }, { access: { canRead: false, canWrite: true } }, { archivedAt: 'date' }, { deletedAt: 'date' }, { sendCapability: undefined }, { sendCapability: { allowed: false, reasonCode: 'runtime_unavailable', reason: 'specific actionable reason' } }]) assert.ok(conversationSendDenial({ ...ready(), session: { ...ready().session, ...patch } }, scope))
  assert.match(conversationSendDenial({ ...ready(), session: { ...ready().session, sendCapability: { allowed: false, reason: 'specific actionable reason' } } }, scope), /specific actionable reason/)
})
