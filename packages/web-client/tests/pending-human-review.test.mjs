import test from 'node:test'
import assert from 'node:assert/strict'
import { PendingHumanReview, ReviewVersionConflict } from '../dist/pending-human-review.js'
import { ApiError } from '../dist/errors.js'

const scope = { host: 'http://127.0.0.1:4001', account: 'alice', teamId: 'team', projectId: 'project', taskId: 'task' }
const input = { version: 4, runId: 'run', summary: '成果', evidence: ['ref://one'] }
const receipt = body => ({ runId: body.runId, task: { id: scope.taskId, projectId: scope.projectId, status: 'in_review', currentReviewId: 'review' }, review: { id: 'review', projectId: scope.projectId, taskId: scope.taskId, taskRunId: body.runId, status: 'requested', actor: 'alice', reviewer: null, decidedAt: null, closedAt: null } })
function storage() {
  const data = new Map()
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } }
}

test('lost response survives remount, replays immutable original even when Task version and form change', async () => {
  const s = storage(), original = new PendingHumanReview(() => s, scope, () => 'request-1')
  let committed
  await assert.rejects(original.run(() => input, async body => { committed = body; throw Error('lost response') }), /lost response/)
  assert.deepEqual(original.read(), committed)
  const remounted = new PendingHumanReview(() => s, scope, () => 'request-2')
  assert.deepEqual(remounted.read(), committed)
  let sent
  const result = await remounted.run(() => { throw Error('must not create a new review') }, async body => { sent = body; return receipt(body) })
  assert.deepEqual(sent, committed)
  assert.equal(result.review.status, 'requested')
  assert.equal(remounted.read(), null)
})

test('scopes records and never discards mismatched or malformed receipts', async () => {
  const s = storage(), pending = new PendingHumanReview(() => s, scope, () => 'request-1')
  await assert.rejects(pending.run(() => input, async body => ({ ...receipt(body), runId: 'other-run' })), /不符/)
  assert.ok(pending.read())
  await assert.rejects(pending.run(() => input, async body => { const bad = receipt(body); delete bad.review.id; delete bad.task.currentReviewId; return bad }), /不符/)
  assert.ok(pending.read())
  await assert.rejects(pending.run(() => input, async body => ({ ...receipt(body), review: { ...receipt(body).review, reviewer: 'alice' } })), /不符/)
  assert.ok(pending.read())
  assert.equal(new PendingHumanReview(() => s, { ...scope, account: 'bob' }).read(), null)
  assert.equal(new PendingHumanReview(() => s, { ...scope, host: 'http://127.0.0.1:4002' }).read(), null)
  s.setItem(pending.key, '{')
  assert.throws(() => pending.read(), /无法读取/)
  await assert.rejects(pending.run(() => input, async () => { throw Error('must not send') }), /无法读取/)
})

test('authoritative version conflict retains original until explicit reconfirmation, unknown outcome cannot be discarded', async () => {
  const s = storage(), pending = new PendingHumanReview(() => s, scope, () => 'request-1')
  await assert.rejects(pending.run(() => input, async () => { throw new ApiError('Task changed', 409, 'server', 'version_conflict') }), ReviewVersionConflict)
  assert.equal(pending.read()?.version, input.version)
  assert.throws(() => pending.discardRejected('other-request'), /已变化/)
  pending.discardRejected('request-1')
  assert.equal(pending.read(), null)
  const fresh = new PendingHumanReview(() => s, scope, () => 'request-2')
  let sent
  await fresh.run(() => ({ ...input, version: input.version + 1 }), async body => { sent = body; return receipt(body) })
  assert.equal(sent.version, input.version + 1)
  assert.equal(sent.requestId, 'request-2')
  await assert.rejects(fresh.run(() => input, async () => { throw new ApiError('network', undefined, 'network') }), /network/)
  assert.ok(fresh.read())
  assert.throws(() => fresh.discardRejected(fresh.read().requestId), /结果尚未确定/)
})

test('uncertain response and malformed receipt never authorize discarding the pending request', async () => {
  const s = storage(), pending = new PendingHumanReview(() => s, scope, () => 'network-1')
  await assert.rejects(pending.run(() => input, async () => { throw Error('disconnected') }), /disconnected/)
  assert.throws(() => pending.discardRejected('network-1'), /结果尚未确定/)
  await assert.rejects(pending.run(() => input, async body => ({ ...receipt(body), review: { ...receipt(body).review, decidedAt: undefined } })), /不符/)
  assert.throws(() => pending.discardRejected('network-1'), /结果尚未确定/)
})

test('an active send cannot be discarded even if an earlier request had a definitive conflict', async () => {
  const s = storage(), pending = new PendingHumanReview(() => s, scope, () => 'conflict-1')
  await assert.rejects(pending.run(() => input, async () => { throw new ApiError('Task changed', 409, 'server', 'version_conflict') }), ReviewVersionConflict)
  let release
  const pendingSend = pending.run(() => { throw Error('must reuse') }, async () => new Promise(resolve => { release = resolve }))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.throws(() => pending.discardRejected('conflict-1'), /仍在发送/)
  release(receipt(pending.read()))
  await pendingSend
})

test('parallel clicks send once; blocked persistence sends nothing', async () => {
  const s = storage(), pending = new PendingHumanReview(() => s, scope, () => 'request-1')
  let sends = 0
  const send = async body => { sends++; await new Promise(resolve => setTimeout(resolve, 5)); return receipt(body) }
  const [first, second] = await Promise.all([pending.run(() => input, send), pending.run(() => { throw Error('duplicate') }, send)])
  assert.deepEqual(first, second)
  assert.equal(sends, 1)
  const broken = { getItem: () => null, setItem: () => { throw Error('quota') }, removeItem: () => {} }
  let called = false
  await assert.rejects(new PendingHumanReview(() => broken, scope).run(() => input, async () => { called = true; return receipt(input) }), /无法保存/)
  assert.equal(called, false)
})
