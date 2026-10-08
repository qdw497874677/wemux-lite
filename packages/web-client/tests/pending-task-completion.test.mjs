import test from 'node:test'
import assert from 'node:assert/strict'
import { PendingTaskCompletion, CompletionVersionConflict } from '../dist/pending-task-completion.js'
import { ApiError } from '../dist/errors.js'

const scope = { host: 'http://127.0.0.1:4001', account: 'alice', teamId: 'team', projectId: 'project', taskId: 'task' }
const input = { version: 7, runId: 'run', summary: '成果', evidence: ['ref://one'] }
const receipt = body => ({ runId: body.runId, task: { id: scope.taskId, projectId: scope.projectId, status: 'done', currentReviewId: null } })
function storage() {
  const data = new Map()
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } }
}

test('lost completion response survives remount and replays the immutable original request', async () => {
  const s = storage(), original = new PendingTaskCompletion(() => s, scope, () => 'request-1')
  let committed
  await assert.rejects(original.run(() => input, async body => { committed = body; throw Error('lost response') }), /lost response/)
  assert.deepEqual(original.read(), committed)
  const remounted = new PendingTaskCompletion(() => s, scope, () => 'request-2')
  assert.deepEqual(remounted.read(), committed)
  let sent
  const result = await remounted.run(() => { throw Error('must not create a new completion') }, async body => { sent = body; return receipt(body) })
  assert.deepEqual(sent, committed)
  assert.equal(result.task.status, 'done')
  assert.equal(remounted.read(), null)
})

test('scopes records and rejects mismatched receipts without discarding the original', async () => {
  const s = storage(), pending = new PendingTaskCompletion(() => s, scope, () => 'request-1')
  await assert.rejects(pending.run(() => input, async body => ({ ...receipt(body), runId: 'other-run' })), /不符/)
  assert.ok(pending.read())
  await assert.rejects(pending.run(() => input, async body => ({ ...receipt(body), task: { ...receipt(body).task, status: 'in_progress' } })), /不符/)
  assert.ok(pending.read())
  await assert.rejects(pending.run(() => input, async body => ({ ...receipt(body), task: { ...receipt(body).task, currentReviewId: 'review' } })), /不符/)
  assert.ok(pending.read())
  assert.equal(new PendingTaskCompletion(() => s, { ...scope, account: 'bob' }).read(), null)
  assert.equal(new PendingTaskCompletion(() => s, { ...scope, host: 'http://127.0.0.1:4002' }).read(), null)
  s.setItem(pending.key, '{')
  assert.throws(() => pending.read(), /无法读取/)
  await assert.rejects(pending.run(() => input, async () => { throw Error('must not send') }), /无法读取/)
})

test('authoritative version conflict retains original until explicit reconfirmation', async () => {
  const s = storage(), pending = new PendingTaskCompletion(() => s, scope, () => 'request-1')
  await assert.rejects(pending.run(() => input, async () => { throw new ApiError('Task changed', 409, 'server', 'version_conflict') }), CompletionVersionConflict)
  assert.equal(pending.read()?.version, input.version)
  assert.throws(() => pending.discardRejected('other-request'), /已变化/)
  pending.discardRejected('request-1')
  assert.equal(pending.read(), null)
  const fresh = new PendingTaskCompletion(() => s, scope, () => 'request-2')
  let sent
  await fresh.run(() => ({ ...input, version: input.version + 1 }), async body => { sent = body; return receipt(body) })
  assert.equal(sent.version, input.version + 1)
  assert.equal(sent.requestId, 'request-2')
})

test('uncertain outcomes never authorize discarding the pending completion', async () => {
  const s = storage(), pending = new PendingTaskCompletion(() => s, scope, () => 'network-1')
  await assert.rejects(pending.run(() => input, async () => { throw Error('disconnected') }), /disconnected/)
  assert.throws(() => pending.discardRejected('network-1'), /结果尚未确定/)
  await assert.rejects(pending.run(() => input, async body => ({ ...receipt(body), task: null })), /不符/)
  assert.throws(() => pending.discardRejected('network-1'), /结果尚未确定/)
})

test('concurrent calls share one flight; success clears storage exactly once', async () => {
  const s = storage(), pending = new PendingTaskCompletion(() => s, scope, () => 'request-1')
  let sends = 0
  const send = async body => { sends++; await new Promise(resolve => setTimeout(resolve, 5)); return receipt(body) }
  const [a, b] = await Promise.all([pending.run(() => input, send), pending.run(() => input, send)])
  assert.equal(sends, 1)
  assert.equal(a.task.status, 'done')
  assert.equal(b.task.status, 'done')
  assert.equal(pending.read(), null)
})
