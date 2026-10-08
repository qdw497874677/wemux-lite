import test from 'node:test'
import assert from 'node:assert/strict'
import { PendingHumanDecision, DecisionVersionConflict } from '../dist/pending-human-decision.js'
import { ApiError } from '../dist/errors.js'

const scope = { host: 'http://127.0.0.1:4001', account: 'alice', teamId: 'team', projectId: 'project', taskId: 'task' }
const intent = { version: 8, reviewId: 'review', status: 'approved' }
function storage() {
  const data = new Map()
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } }
}
const createdAt = '2026-04-01T10:00:00.000Z'
const requestedAt = '2026-04-01T11:00:00.000Z'
const decidedAt = '2026-04-01T12:00:00.000Z'
function receipt(body) {
  return {
    task: { id: scope.taskId, projectId: scope.projectId, version: body.version + 1, status: body.status === 'approved' ? 'done' : 'in_progress', currentReviewId: null, createdAt, updatedAt: decidedAt, lastActivityAt: decidedAt },
    review: { id: body.reviewId, taskId: scope.taskId, projectId: scope.projectId, taskRunId: 'run', status: body.status, actor: 'submitter', reviewer: 'alice', requestedAt, decidedAt, closedAt: decidedAt },
  }
}

test('lost decision response replays the same immutable reviewer intent across remount', async () => {
  const s = storage(), decision = new PendingHumanDecision(() => s, scope, 'alice', () => 'vote-1')
  let original
  await assert.rejects(decision.run(() => intent, async body => { original = body; throw Error('network') }), /network/)
  assert.deepEqual(decision.read(), original)
  const remount = new PendingHumanDecision(() => s, scope, 'alice', () => 'vote-2')
  let sent
  await remount.run(() => { throw Error('must reuse') }, async body => { sent = body; return receipt(body) })
  assert.deepEqual(sent, original)
  assert.equal(remount.read(), null)
})

test('a staged advance receipt is a definitive outcome, not a mismatch', async () => {
  const s = storage(), decision = new PendingHumanDecision(() => s, scope, 'alice', () => 'stage-1')
  const staged = body => ({ ...receipt(body), task: { ...receipt(body).task, status: 'in_review', currentReviewId: 'successor-review' }, review: { ...receipt(body).review, stageIndex: 1, stageCount: 2 } })
  const result = await decision.run(() => ({ ...intent, reviewId: 'stage-1-review' }), async body => staged(body))
  assert.equal(result.task.status, 'in_review')
  assert.equal(result.task.currentReviewId, 'successor-review')
  assert.equal(decision.read(), null, 'an accepted staged advance retires the pending decision')
  const terminal = new PendingHumanDecision(() => s, scope, 'alice', () => 'stage-2')
  await assert.rejects(terminal.run(() => ({ ...intent, reviewId: 'stage-2-review' }), async body => ({ ...staged({ ...body, reviewId: 'stage-2-review' }), task: { ...staged({ ...body, reviewId: 'stage-2-review' }).task, currentReviewId: 'stage-2-review', status: 'in_review' } })), /回执与原请求不符/, 'an approved receipt whose current review is still the decided one is not a staged advance')
})

test('decision replay is scoped by origin, account, project and task and rejects malformed stored intent', async () => {
  const s = storage(), decision = new PendingHumanDecision(() => s, scope, 'alice', () => 'vote-1')
  await assert.rejects(decision.run(() => intent, async () => { throw Error('lost') }), /lost/)
  for (const changed of [{ account: 'bob' }, { host: 'http://127.0.0.1:4002' }, { projectId: 'other' }, { taskId: 'other' }]) assert.equal(new PendingHumanDecision(() => s, { ...scope, ...changed }, 'alice').read(), null)
  s.setItem(decision.key, '{')
  assert.throws(() => decision.read(), /无法读取/)
  let called = false
  await assert.rejects(decision.run(() => intent, async () => { called = true; return receipt(intent) }), /无法读取/)
  assert.equal(called, false)
})

test('unknown outcomes and mismatched decision receipts retain exact pending identity', async () => {
  const s = storage(), decision = new PendingHumanDecision(() => s, scope, 'alice', () => 'vote-1')
  await assert.rejects(decision.run(() => intent, async body => ({ ...receipt(body), review: { ...receipt(body).review, reviewer: null } })), /不符/)
  assert.equal(decision.read().requestId, 'vote-1')
  await assert.rejects(decision.run(() => { throw Error('new intent must not run') }, async body => ({ ...receipt(body), task: { ...receipt(body).task, status: 'in_review' } })), /不符/)
  assert.equal(decision.read().status, 'approved')
  await assert.rejects(decision.run(() => intent, async body => ({ ...receipt(body), review: { ...receipt(body).review, reviewer: 'other' } })), /不符/)
  await assert.rejects(decision.run(() => intent, async body => ({ ...receipt(body), review: { id: body.reviewId, taskId: scope.taskId, projectId: scope.projectId, status: body.status, decidedAt: 'now', closedAt: 'now' } })), /不符/)
  assert.equal(decision.read().requestId, 'vote-1')
})

test('only a proven CAS rejection may retire the original decision; unknown outcomes stay pending', async () => {
  const s = storage(), decision = new PendingHumanDecision(() => s, scope, 'alice', () => 'vote-1')
  await assert.rejects(decision.run(() => intent, async () => { throw Error('offline') }), /offline/)
  assert.throws(() => decision.discardRejected(), /只有明确/)
  await assert.rejects(decision.run(() => intent, async () => { throw new ApiError('collision', 409, 'server', 'request_id_conflict') }), /未确认/)
  assert.throws(() => decision.discardRejected(), /只有明确/)
  await assert.rejects(decision.run(() => intent, async () => { throw new ApiError('stale', 409, 'server', 'version_conflict') }), DecisionVersionConflict)
  decision.discardRejected()
  assert.equal(decision.read(), null)
})

test('parallel decisions coalesce, failed storage writes do not send and changes_requested requires reason', async () => {
  const s = storage(), decision = new PendingHumanDecision(() => s, scope, 'alice', () => 'vote-1')
  let sends = 0
  const send = async body => { sends++; await new Promise(resolve => setTimeout(resolve, 5)); return receipt(body) }
  const [first, second] = await Promise.all([decision.run(() => ({ ...intent, status: 'changes_requested', reason: '请补充证据' }), send), decision.run(() => { throw Error('duplicate') }, send)])
  assert.deepEqual(first, second); assert.equal(sends, 1); assert.equal(decision.read(), null)
  await assert.rejects(decision.run(() => ({ ...intent, status: 'changes_requested' }), async () => { sends++ }), /格式不正确/)
  assert.equal(sends, 1)
  const failed = { getItem: () => null, setItem: () => { throw Error('quota') }, removeItem: () => {} }
  await assert.rejects(new PendingHumanDecision(() => failed, scope, 'alice').run(() => intent, async () => { sends++ }), /无法保存/)
  assert.equal(sends, 1)
})

test('joining remount shares the definitive rejection and can discard with instance B', async () => {
  const s = storage(), a = new PendingHumanDecision(() => s, scope, 'alice', () => 'vote-1')
  let rejectSend, sends = 0
  const first = a.run(() => intent, () => { sends++; return new Promise((_, reject) => { rejectSend = reject }) })
  await Promise.resolve()
  const b = new PendingHumanDecision(() => s, scope, 'alice', () => 'vote-2')
  const joined = b.run(() => { throw Error('must join') }, () => { throw Error('must not send twice') })
  assert.equal(first, joined)
  assert.throws(() => b.discardRejected(), /正在发送/)
  const results = Promise.allSettled([first, joined])
  rejectSend(new ApiError('stale', 409, 'server', 'version_conflict'))
  for (const result of await results) {
    assert.equal(result.status, 'rejected')
    assert.ok(result.reason instanceof DecisionVersionConflict)
  }
  assert.equal(sends, 1)
  b.discardRejected()
  assert.equal(a.read(), null)
})

test('shared rejection is invalidated by an uncertain retry, including malformed success', async () => {
  for (const send of [async () => { throw Error('offline') }, async body => ({ ...receipt(body), review: null })]) {
    const s = storage(), a = new PendingHumanDecision(() => s, scope, 'alice', () => 'vote-1')
    await assert.rejects(a.run(() => intent, async () => { throw new ApiError('stale', 409, 'server', 'version_conflict') }), DecisionVersionConflict)
    const original = s.getItem(a.key)
    const b = new PendingHumanDecision(() => s, scope, 'alice')
    await assert.rejects(b.run(() => { throw Error('must reuse') }, send))
    assert.throws(() => a.discardRejected(), /只有明确/)
    assert.throws(() => b.discardRejected(), /只有明确/)
    assert.equal(s.getItem(a.key), original)
  }
})

test('rejection evidence cannot authorize another storage, key or payload', async () => {
  const s = storage(), a = new PendingHumanDecision(() => s, scope, 'alice', () => 'vote-1')
  await assert.rejects(a.run(() => intent, async () => { throw new ApiError('stale', 409, 'server', 'version_conflict') }), DecisionVersionConflict)
  const original = s.getItem(a.key)
  const otherStorage = storage()
  otherStorage.setItem(a.key, original)
  assert.throws(() => new PendingHumanDecision(() => otherStorage, scope, 'alice').discardRejected(), /只有明确/)
  const otherTask = new PendingHumanDecision(() => s, { ...scope, taskId: 'other' }, 'alice')
  s.setItem(otherTask.key, original)
  assert.throws(() => otherTask.discardRejected(), /只有明确/)
  s.setItem(a.key, JSON.stringify({ ...JSON.parse(original), requestId: 'vote-2' }))
  assert.throws(() => a.discardRejected(), /只有明确/)
  // Observing a replacement permanently invalidates the old evidence, even if restored.
  s.setItem(a.key, original)
  assert.throws(() => a.discardRejected(), /只有明确/)
})

const malformed = [
  ['task.version', '8'], ['task.version', 8], ['task.version', 10], ['task.version', 9.5],
  ['review.taskRunId', ''], ['review.taskRunId', '   '], ['review.actor', ''], ['review.actor', 'alice'],
  ['review.id', 'other'], ['review.taskId', 'other'], ['review.projectId', 'other'], ['review.reviewer', 'other'], ['review.status', 'requested'],
  ['task.id', 'other'], ['task.projectId', 'other'], ['task.currentReviewId', 'review'], ['task.status', 'in_review'],
  ['review.requestedAt', '2026-04-01T13:00:00.000Z'], ['review.closedAt', '2026-04-01T13:00:00.000Z'],
  ['task.createdAt', decidedAt], ['task.updatedAt', requestedAt], ['task.lastActivityAt', requestedAt],
]
for (const field of ['task.version', 'review.taskRunId', 'review.actor', 'review.id', 'review.taskId', 'review.projectId', 'review.reviewer', 'review.status', 'task.id', 'task.projectId', 'task.currentReviewId', 'task.status']) malformed.push([field, undefined])
for (const field of ['review.requestedAt', 'review.decidedAt', 'review.closedAt', 'task.createdAt', 'task.updatedAt', 'task.lastActivityAt']) {
  for (const value of [undefined, null, '', 'now', '2026-04-01', '2026-02-30T12:00:00.000Z']) malformed.push([field, value])
}
for (const [field, value] of malformed) {
  test(`malformed successful decision receipt preserves exact persisted intent: ${field}=${JSON.stringify(value)}`, async () => {
    const s = storage(), decision = new PendingHumanDecision(() => s, scope, 'alice', () => 'vote-1')
    let original
    await assert.rejects(decision.run(() => intent, async body => {
      original = s.getItem(decision.key)
      const result = receipt(body), [part, name] = field.split('.')
      if (value === undefined) delete result[part][name]
      else result[part][name] = value
      return result
    }), /不符/)
    assert.equal(s.getItem(decision.key), original)
    assert.throws(() => decision.discardRejected(), /只有明确/)
    await new PendingHumanDecision(() => s, scope, 'alice').run(() => { throw Error('must reuse') }, async body => {
      assert.deepEqual(body, JSON.parse(original))
      return receipt(body)
    })
    assert.equal(decision.read(), null)
  })
}

test('a CAS rejection cannot mark a replacement payload written during the flight', async () => {
  const s = storage(), decision = new PendingHumanDecision(() => s, scope, 'alice', () => 'vote-1')
  await assert.rejects(decision.run(() => intent, async body => {
    s.setItem(decision.key, JSON.stringify({ ...body, requestId: 'replacement' }))
    throw new ApiError('stale', 409, 'server', 'version_conflict')
  }), /身份已变化/)
  assert.equal(decision.read().requestId, 'replacement')
  assert.throws(() => new PendingHumanDecision(() => s, scope, 'alice').discardRejected(), /只有明确/)
})
