import test from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_EVENT_KINDS } from '@wemux/domain'
import {
  appendConversationEvents, createConversationProjection, projectConversationEvents, ConversationProjectionError,
} from '../src/conversation-projection.ts'

const stamp = '2026-06-01T00:00:00.000Z'
const event = (seq, payload, extra = {}) => ({ sessionId: 's', seq, occurredAt: stamp, payload, ...extra })
const queued = (messageId = 'm', position = 0) => ({ kind: 'message.queued', commandId: `send:${messageId}`, messageId, content: '  用户原文\n你好  ', position, sentByAccountId: 'sender' })
const started = (turnId = 't', messageId = 'm') => ({ kind: 'turn.started', turnId, messageId })
const delta = (text, streamKind, turnId = 't') => ({ kind: 'assistant.text.delta', turnId, text, ...(streamKind === undefined ? {} : { streamKind }) })
const toolStart = (toolCallId = 'tool', turnId = 't') => ({ kind: 'tool.started', turnId, toolCallId, toolName: 'shell', input: { command: 'printf hello', options: [1, null, { safe: true }] }, streamKind: 'command_output' })
const toolOutput = (text, toolCallId = 'tool', turnId = 't') => ({ kind: 'tool.output.delta', turnId, toolCallId, text, streamKind: 'command_output' })
const toolFinish = (exitCode, toolCallId = 'tool', turnId = 't') => ({ kind: 'tool.finished', turnId, toolCallId, exitCode })
const requested = (approvalId = 'a', turnId = 't') => ({ kind: 'approval.requested', turnId, approvalId, action: { kind: 'write', files: ['x'] }, reason: 'confirm' })
const resolved = (decision = 'approve', approvalId = 'a', turnId = 't') => ({ kind: 'approval.resolved', turnId, approvalId, decision, decidedByAccountId: 'reviewer' })
const expired = (reason = 'timeout', approvalId = 'a', turnId = 't') => ({ kind: 'approval.expired', turnId, approvalId, reason })
const finished = (outcome = 'completed', failure = null, turnId = 't') => ({ kind: 'turn.finished', turnId, outcome, failure })
const usage = { scope: 'operation', subjectId: 'op', source: 'runtime', revision: 2, completeness: 'complete', modelId: 'provider::model', inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 14, costUsd: 0.001, currency: 'USD' }
const failure = { code: 'agent-error', message: 'not enough quota', failureReason: 'agent_error.provider_quota_limit', abortReason: 'provider_error', retryable: false }
const variants = [
  queued(), { kind: 'message.cancelled', commandId: 'cancel', messageId: 'm' }, started(), delta('hello'), toolStart(), toolOutput('out'), toolFinish(0),
  requested(), resolved(), expired(), { kind: 'usage.updated', turnId: 't', usage },
  { kind: 'compaction.started', turnId: 't', reason: 'context full' }, { kind: 'compaction.finished', turnId: 't', summary: 'summary' },
  finished('failed', failure), { kind: 'model.changed', previousModelId: null, modelId: 'provider::new' },
  { kind: 'runtime.notice', level: 'warning', code: 'retry', message: 'waiting', retry: { attempt: 1, maxAttempts: 3, delayMs: 1000 } },
  { kind: 'session.runtime.changed', state: 'unavailable', reason: 'offline' },
]
const journal = payloads => payloads.map((p, i) => event(i + 1, p))
const project = payloads => projectConversationEvents('s', journal(payloads))
const errorCode = code => e => e instanceof ConversationProjectionError && e.code === code
function assertDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) assertDeepFrozen(child)
}

// Behavioral coverage stays aligned with the authoritative domain variant registry.
test('every authoritative Journal variant is interpreted and preserves payload, sequence, timestamp and IDs', () => {
  assert.deepEqual(variants.map(v => v.kind).sort(), [...SESSION_EVENT_KINDS].sort())
  for (const payload of variants) {
    const snapshot = project([payload])
    assert.equal(snapshot.lastAppliedSeq, 1)
    assert.deepEqual(snapshot.timeline, [{ seq: 1, occurredAt: stamp, kind: 'event', payload }])
    assertDeepFrozen(snapshot)
  }
})

test('mixed transcript preserves timeline order and separates assistant, reasoning and plan around tools', () => {
  const events = journal([
    queued('m', 7), queued('cancelled', 0), { kind: 'message.cancelled', commandId: 'cancel', messageId: 'cancelled' }, started(),
    delta('think', 'reasoning_text'), delta(' more', 'reasoning_text'), delta('1. plan', 'plan_text'), delta('hello '), delta('world'),
    toolStart(), toolOutput('one'), toolOutput('two'), toolFinish(0), delta('after'),
    requested(), resolved(), { kind: 'usage.updated', turnId: 't', usage },
    { kind: 'compaction.started', turnId: 't', reason: 'full' }, { kind: 'compaction.finished', turnId: 't', summary: 'short' },
    { kind: 'runtime.notice', level: 'info', code: 'cooldown', message: 'wait', retry: { attempt: 2, maxAttempts: null, delayMs: null } },
    { kind: 'model.changed', previousModelId: 'provider::old', modelId: 'provider::new' },
    { kind: 'session.runtime.changed', state: 'idle', reason: null }, finished(), queued('next', 3),
  ])
  const s = projectConversationEvents('s', events)
  assert.deepEqual(s.timeline.map(e => e.seq), events.map(e => e.seq))
  assert.deepEqual(s.timeline.map(e => e.payload), events.map(e => e.payload))
  assert.deepEqual(s.textSegments.map(({ seq, throughSeq, streamKind, text }) => ({ seq, throughSeq, streamKind, text })), [
    { seq: 5, throughSeq: 6, streamKind: 'reasoning_text', text: 'think more' },
    { seq: 7, throughSeq: 7, streamKind: 'plan_text', text: '1. plan' },
    { seq: 8, throughSeq: 9, streamKind: 'assistant_text', text: 'hello world' },
    { seq: 14, throughSeq: 14, streamKind: 'assistant_text', text: 'after' },
  ])
  assert.deepEqual(s.messages.map(m => [m.messageId, m.commandId, m.state, m.turnId, m.cancellationCommandId]), [
    ['m', 'send:m', 'claimed', 't', null], ['cancelled', 'send:cancelled', 'cancelled', null, 'cancel'], ['next', 'send:next', 'queued', null, null],
  ])
  assert.equal(s.messages[0].content, queued().content)
  assert.equal(s.messages[0].sentByAccountId, 'sender')
  assert.deepEqual(s.queuedMessages.map(m => m.messageId), ['next'])
  assert.equal(s.turns[0].state, 'completed')
  assert.equal(s.turns[0].started.seq, 4)
  assert.equal(s.turns[0].finished.seq, 23)
  assert.equal(s.tools[0].output, 'onetwo')
  assert.deepEqual(s.tools[0].outputChunks.map(c => c.seq), [11, 12])
  assert.equal(s.tools[0].state, 'completed')
  assert.equal(s.tools[0].exitCode, 0)
  assert.deepEqual(s.tools[0].input, toolStart().input)
  assert.equal(s.approvals[0].decision, 'approve')
  assert.equal(s.approvals[0].decidedByAccountId, 'reviewer')
  assert.deepEqual(s.pendingApprovals, [])
  assert.deepEqual(s.runtime, { seq: 22, occurredAt: stamp, state: 'idle', reason: null })
  assert.deepEqual(s.model, { seq: 21, occurredAt: stamp, previousModelId: 'provider::old', modelId: 'provider::new' })
  assert.equal('taskState' in s, false)
})

for (const reason of ['timeout', 'cancelled', 'turn_released', 'shutdown']) test(`automatic ${reason} expires only exact pending identity and survives replay`, () => {
  const payloads = [requested(), requested('a', 'other'), expired(reason), resolved(), requested()]
  const s = project(payloads)
  assert.equal(s.approvals[0].expired, true)
  assert.equal(s.approvals[0].decision, null)
  assert.equal(s.approvals[0].resolved, null)
  assert.deepEqual(s.pendingApprovals.map(a => a.turnId), ['other'])
  assert.deepEqual(appendConversationEvents(project(payloads.slice(0, 2)), journal(payloads).slice(2)), s)
  assert.equal(project([requested(), resolved(), expired(reason)]).approvals[0].expired, false)
  assert.equal(project([expired(reason), requested()]).pendingApprovals.length, 1)
})

test('queue keeps authoritative event order and positions instead of sorting by arrival metadata', () => {
  const s = project([queued('late-position', 9), queued('first-position', 0), queued('same-position', 0)])
  assert.deepEqual(s.queuedMessages.map(m => [m.messageId, m.position]), [['late-position', 9], ['first-position', 0], ['same-position', 0]])
  assert.equal(s.runtime, null)
  assert.deepEqual(s.turns, [])
})

test('chunked replay, overlaps, repeated same-page events and every split equal full replay', () => {
  const events = journal([queued(), started(), delta('a'), delta('b'), toolStart(), toolOutput('x'), toolOutput('y'), toolFinish(0), delta('c'), ...variants.slice(7)])
  const full = projectConversationEvents('s', events)
  for (let split = 0; split <= events.length; split++) {
    const prefix = projectConversationEvents('s', events.slice(0, split))
    const before = structuredClone(prefix)
    assert.deepEqual(appendConversationEvents(prefix, events.slice(Math.max(0, split - 2))), full)
    assert.deepEqual(prefix, before)
  }
  let chunked = createConversationProjection('s')
  for (const e of events) chunked = appendConversationEvents(chunked, [e, e])
  assert.deepEqual(chunked, full)
  assert.equal(appendConversationEvents(full, events), full)
  assert.equal(appendConversationEvents(full, []), full)
  assert.equal(appendConversationEvents(full, [events[5], events[1]]), full)
})

test('exact replay is structural, object key order independent, but all payload fields and timestamps matter', () => {
  const original = event(1, { ...toolStart(), extra: { a: 1, b: [2, 3] } })
  const s = projectConversationEvents('s', [original])
  const reordered = { ...original, payload: { extra: { b: [2, 3], a: 1 }, ...toolStart() } }
  assert.equal(appendConversationEvents(s, [reordered]), s)
  for (const conflict of [
    { ...original, occurredAt: '2026-06-01T00:00:01.000Z' },
    { ...original, payload: { ...original.payload, toolName: 'different' } },
    { ...original, payload: { ...original.payload, extra: { a: 1, b: [3, 2] } } },
    { ...original, payload: toolStart() },
  ]) assert.throws(() => appendConversationEvents(s, [conflict]), errorCode('conflicting-sequence'))
  assert.throws(() => projectConversationEvents('s', [original, { ...original, payload: toolStart() }]), errorCode('conflicting-sequence'))
})

test('wrong Session, gaps, out-of-order new events and malformed later events reject the whole page', () => {
  const s = project([queued()]), before = structuredClone(s)
  const cases = [
    [[event(2, started()), event(3, delta('bad'), { sessionId: 'other' })], 'wrong-session'],
    [[event(2, started()), event(4, delta('gap'))], 'gap'],
    [[event(3, delta('out-of-order')), event(2, started())], 'gap'],
    [[event(2, started()), event(3, { kind: 'assistant.text.delta', turnId: 't', text: 12 })], 'invalid-event'],
    [[event(2, started()), event(1, queued('conflict'))], 'conflicting-sequence'],
  ]
  for (const [batch, code] of cases) {
    assert.throws(() => appendConversationEvents(s, batch), errorCode(code))
    assert.deepEqual(s, before)
    assert.equal(s.lastAppliedSeq, 1)
    assert.deepEqual(s.turns, [])
  }
  assert.throws(() => projectConversationEvents('s', [event(2, queued())]), errorCode('gap'))
  assert.throws(() => appendConversationEvents(s, [event(1, queued(), { sessionId: 'other' })]), errorCode('wrong-session'))
})

test('known payload required fields and malformed optionals are validated, not asserted from envelope', () => {
  const malformed = [
    ['message.queued', { position: -1 }], ['message.queued', { position: 0.5 }], ['message.queued', { content: null }], ['message.queued', { sentByAccountId: 3 }],
    ['message.cancelled', { commandId: '' }], ['turn.started', { messageId: [] }],
    ['assistant.text.delta', { text: {} }], ['assistant.text.delta', { streamKind: 'command_output' }],
    ['tool.started', { toolName: false }], ['tool.started', { streamKind: 'assistant_text' }],
    ['tool.output.delta', { text: [] }], ['tool.output.delta', { streamKind: 'reasoning_text' }],
    ['tool.finished', { exitCode: '0' }], ['tool.finished', { exitCode: 0.2 }],
    ['approval.requested', { approvalId: null }], ['approval.requested', { reason: [] }],
    ['approval.expired', { reason: 'approve' }], ['approval.expired', { turnId: '' }],
    ['approval.resolved', { decision: 'expired' }], ['approval.resolved', { decidedByAccountId: false }],
    ['usage.updated', { usage: null }], ['usage.updated', { usage: { scope: 'turn' } }], ['usage.updated', { usage: { inputTokens: -1 } }],
    ['usage.updated', { usage: { outputTokens: 0.2 } }], ['usage.updated', { usage: { source: 'estimated' } }], ['usage.updated', { usage: { revision: -1 } }],
    ['usage.updated', { usage: { completeness: 'unknown' } }], ['usage.updated', { usage: { costUsd: -1 } }], ['usage.updated', { usage: { currency: 'EUR' } }],
    ['usage.updated', { usage: { subjectId: 4 } }], ['usage.updated', { usage: { modelId: {} } }],
    ['compaction.started', { reason: false }], ['compaction.finished', { summary: 0 }],
    ['turn.finished', { outcome: 'accepted' }], ['turn.finished', { failure: {} }], ['turn.finished', { failure: { ...failure, code: 'other' } }],
    ['turn.finished', { failure: { ...failure, message: null } }], ['turn.finished', { failure: { ...failure, abortReason: 'other' } }],
    ['turn.finished', { failure: { ...failure, failureReason: 'agent_error.other' } }], ['turn.finished', { failure: { ...failure, retryable: 1 } }],
    ['model.changed', { previousModelId: 0 }], ['model.changed', { modelId: '' }],
    ['runtime.notice', { level: 'error' }], ['runtime.notice', { code: null }], ['runtime.notice', { message: null }],
    ['runtime.notice', { retry: {} }], ['runtime.notice', { retry: { attempt: -1, maxAttempts: null, delayMs: null } }],
    ['runtime.notice', { retry: { attempt: 1, maxAttempts: 1.5, delayMs: null } }], ['runtime.notice', { retry: { attempt: 1, maxAttempts: 2, delayMs: -1 } }],
    ['session.runtime.changed', { state: 'waiting_for_approval' }], ['session.runtime.changed', { reason: false }],
  ]
  const required = {
    'message.queued': ['commandId', 'messageId', 'content', 'position'], 'message.cancelled': ['commandId', 'messageId'],
    'turn.started': ['turnId', 'messageId'], 'assistant.text.delta': ['turnId', 'text'],
    'tool.started': ['turnId', 'toolCallId', 'toolName', 'input'], 'tool.output.delta': ['turnId', 'toolCallId', 'text'], 'tool.finished': ['turnId', 'toolCallId', 'exitCode'],
    'approval.expired': ['turnId', 'approvalId', 'reason'],
    'approval.requested': ['turnId', 'approvalId', 'action'], 'approval.resolved': ['turnId', 'approvalId', 'decision'],
    'usage.updated': ['turnId', 'usage'], 'compaction.started': ['turnId'], 'compaction.finished': ['turnId'],
    'turn.finished': ['turnId', 'outcome', 'failure'], 'model.changed': ['previousModelId', 'modelId'],
    'runtime.notice': ['level', 'code', 'message'], 'session.runtime.changed': ['state', 'reason'],
  }
  const invalidPayloads = malformed.map(([kind, overrides]) => ({ ...variants.find(v => v.kind === kind), ...overrides }))
  for (const variant of variants) for (const key of required[variant.kind]) {
    const missing = { ...variant }; delete missing[key]; invalidPayloads.push(missing)
  }
  const s = project([queued()]), before = structuredClone(s)
  for (const payload of invalidPayloads) {
    assert.throws(() => appendConversationEvents(s, [event(2, started()), event(3, payload)]), errorCode('invalid-event'), JSON.stringify(payload))
    assert.deepEqual(s, before)
  }
})

test('malformed envelopes reject even for unsupported variants', () => {
  for (const extra of [
    { seq: 0 }, { seq: -1 }, { seq: 1.5 }, { seq: NaN }, { seq: Number.MAX_SAFE_INTEGER }, { seq: '1' },
    { sessionId: '' }, { occurredAt: '' }, { occurredAt: 'not a timestamp' }, { occurredAt: null },
    { payload: null }, { payload: [] }, { payload: {} }, { payload: { kind: '' } }, { payload: { kind: 42 } },
  ]) assert.throws(() => projectConversationEvents('s', [event(1, { kind: 'future' }, extra)]), errorCode('invalid-event'))
  for (const sessionId of ['', '  ', null, 4]) assert.throws(() => createConversationProjection(sessionId), errorCode('invalid-event'))
})

test('future kinds, including legacy-only message.rejected and command acceptance, are explicitly unsupported', () => {
  const events = journal([queued(), { kind: 'command.accepted', commandId: 'send:m' },
    { kind: 'message.rejected', messageId: 'm', reason: 'legacy' }, { kind: 'future.kind', nested: [1, { x: true }] }, started()])
  const s = projectConversationEvents('s', events)
  assert.deepEqual(s.timeline.map(e => e.kind), ['event', 'unsupported', 'unsupported', 'unsupported', 'event'])
  assert.deepEqual(s.timeline[3].payload, events[3].payload)
  assert.equal(s.lastAppliedSeq, 5)
  assert.equal(s.turns[0].state, 'running')
  assert.equal(s.messages[0].state, 'claimed')
  assert.equal(s.runtime, null)
  assert.equal(appendConversationEvents(s, events), s)
  assert.throws(() => appendConversationEvents(s, [event(4, { kind: 'future.kind', nested: [] })]), errorCode('conflicting-sequence'))
})

test('Turn outcomes retain failures and expire unresolved approvals without inventing human decisions', () => {
  for (const outcome of ['completed', 'cancelled', 'failed']) {
    const s = project([queued(), started(), requested(), toolStart(), delta('unfinished plan', 'plan_text'), finished(outcome, outcome === 'failed' ? failure : null)])
    assert.equal(s.turns[0].state, outcome)
    assert.deepEqual(s.turns[0].failure, outcome === 'failed' ? failure : null)
    assert.equal(s.approvals[0].decision, null)
    assert.equal(s.approvals[0].expired, true)
    assert.deepEqual(s.pendingApprovals, [])
    assert.equal(s.tools[0].finished, null)
    assert.equal(s.tools[0].state, 'running') // Last explicit tool state, not fabricated success/failure.
    assert.equal(s.runtime, null)
    assert.equal(s.textSegments[0].text, 'unfinished plan')
    assert.equal('taskState' in s, false)
  }
  const s = project([started(), finished('cancelled', { code: 'interrupted', message: 'stopped', abortReason: 'user_stop' })])
  assert.equal(s.turns[0].failure.abortReason, 'user_stop')
})

test('tools preserve unknown input data, distinguish null exit from success, and scope identities to Turn', () => {
  for (const [exitCode, state] of [[0, 'completed'], [1, 'failed'], [-9, 'failed'], [null, 'finished']]) {
    const s = project([toolStart(), toolFinish(exitCode)])
    assert.equal(s.tools[0].state, state)
    assert.equal(s.tools[0].exitCode, exitCode)
    assert.equal(s.tools[0].finished.seq, 2)
  }
  for (const input of [null, undefined, 'string', 17, true, ['array'], { unusual: { nested: [true, null] } }]) {
    const s = project([{ ...toolStart(), input }])
    assert.deepEqual(s.tools[0].input, input)
  }
  const s = project([toolStart('shared', 't1'), toolStart('shared', 't2'), toolOutput('one', 'shared', 't1'), toolOutput('two', 'shared', 't2'),
    { ...toolOutput('file', 'shared', 't1'), streamKind: 'file_change_output' }, toolFinish(0, 'shared', 't2')])
  assert.deepEqual(s.tools.map(t => [t.turnId, t.output, t.state]), [['t1', 'onefile', 'running'], ['t2', 'two', 'completed']])
  assert.deepEqual(s.tools[0].outputChunks.map(c => c.streamKind), ['command_output', 'file_change_output'])
  const orphan = project([toolOutput('orphan'), toolFinish(null), delta('no start')])
  assert.equal(orphan.tools[0].started, false)
  assert.equal(orphan.tools[0].toolName, null)
  assert.equal(orphan.turns[0].state, 'unknown')
})

test('Turn models are claim-time facts, absent legacy differs from default and selection cannot rewrite them', () => {
  const s = projectConversationEvents('s', [
    event(1, { kind: 'turn.started', turnId: 'old', messageId: 'm' }),
    event(2, { kind: 'turn.started', turnId: 'default', messageId: 'm2', modelId: null }),
    event(3, { kind: 'turn.started', turnId: 'fixed', messageId: 'm3', modelId: 'first' }),
    event(4, { kind: 'model.changed', previousModelId: 'first', modelId: 'next' }),
    event(5, { kind: 'turn.started', turnId: 'fixed', messageId: 'm3', modelId: 'next' }),
  ])
  assert.deepEqual(s.turns.map(t => t.modelId), [undefined, null, 'first'])
  assert.equal(s.model.modelId, 'next')
  assert.equal(s.turns[2].started.seq, 3)
})

test('approval fold ignores pre-request resolution, duplicates and late terminal decisions', () => {
  const payloads = [resolved('deny'), requested(), { ...requested(), action: 'replacement' }, finished(), resolved('approve'), requested(), requested('a', 'other')]
  const s = projectConversationEvents('s', payloads.map((p, i) => event(i + 1, p)))
  assert.equal(s.approvals[0].seq, 2)
  assert.deepEqual(s.approvals[0].action, requested().action)
  assert.equal(s.approvals[0].decision, null)
  assert.equal(s.approvals[0].expired, true)
  assert.deepEqual(s.pendingApprovals.map(a => a.turnId), ['other'])
  const late = projectConversationEvents('s', [event(1, finished()), event(2, requested())])
  assert.equal(late.approvals[0].expired, true)
  assert.deepEqual(late.pendingApprovals, [])
})

test('approvals distinguish unresolved/approve/deny and scope same approval ID to Turn', () => {
  const s = project([requested('same', 't1'), requested('same', 't2'), requested('pending', 't3'),
    resolved('approve', 'same', 't1'), resolved('deny', 'same', 't2')])
  assert.deepEqual(s.approvals.map(a => [a.turnId, a.decision]), [['t1', 'approve'], ['t2', 'deny'], ['t3', null]])
  assert.deepEqual(s.pendingApprovals.map(a => a.approvalId), ['pending'])
  assert.deepEqual(s.approvals[0].action, requested().action)
  assert.equal(s.approvals[0].resolved.seq, 4)
  const orphan = project([resolved('deny')])
  assert.equal(orphan.approvals[0].requested, false)
  assert.equal(orphan.approvals[0].action, undefined)
  assert.deepEqual(orphan.pendingApprovals, [])
})

test('usage revisions and scopes remain ordered observations without double-counting; compaction and notices stay explicit', () => {
  const payloads = [
    { kind: 'usage.updated', turnId: 't', usage: { ...usage, revision: 1, completeness: 'partial' } },
    { kind: 'usage.updated', turnId: 't', usage },
    { kind: 'usage.updated', turnId: 't', usage: { scope: 'native-session', totalTokens: 100 } },
    { kind: 'usage.updated', turnId: 't', usage: { scope: 'message' } },
    { kind: 'compaction.started', turnId: 't' }, { kind: 'compaction.finished', turnId: 't' },
    { kind: 'runtime.notice', level: 'warning', code: 'retry', message: 'retrying' },
  ]
  const s = project(payloads)
  assert.deepEqual(s.timeline.map(e => e.payload), payloads)
  assert.equal(s.turns[0].state, 'unknown')
  assert.equal(s.runtime, null)
})

test('all authoritative runtime states and explicit model changes leave current Turn execution untouched', () => {
  for (const state of ['idle', 'queued', 'running', 'stopping', 'unavailable', 'failed']) {
    const s = project([started(), { kind: 'model.changed', previousModelId: null, modelId: 'next' }, { kind: 'session.runtime.changed', state, reason: 'reason' }])
    assert.equal(s.runtime.state, state)
    assert.equal(s.runtime.reason, 'reason')
    assert.equal(s.model.modelId, 'next')
    assert.equal(s.turns[0].state, 'running')
    assert.equal('modelId' in s.turns[0], false)
  }
})

test('snapshots are deeply immutable detached data and input is neither changed nor frozen', () => {
  const events = journal([toolStart(), requested(), { kind: 'usage.updated', turnId: 't', usage: { ...usage } }, finished('failed', { ...failure })])
  const before = structuredClone(events)
  const s = projectConversationEvents('s', events)
  assert.deepEqual(events, before)
  assertDeepFrozen(s)
  assert.equal(Object.isFrozen(events[0].payload.input), false)
  events[0].payload.input.options[2].safe = false
  events[1].payload.action.files.push('mutated')
  events[2].payload.usage.inputTokens = 999
  events[3].payload.failure.message = 'mutated'
  assert.deepEqual(s, projectConversationEvents('s', before))
  assert.throws(() => { s.tools[0].input.options[2].safe = false }, TypeError)
  assert.throws(() => s.timeline.push('mutation'), TypeError)
  assert.throws(() => { s.lastAppliedSeq = 99 }, TypeError)
  const frozenInput = Object.freeze([Object.freeze(event(1, Object.freeze(delta('frozen'))))])
  assert.equal(projectConversationEvents('s', frozenInput).textSegments[0].text, 'frozen')
})

test('unknown data is copied safely without executing accessors, toJSON, functions or prototype payloads', () => {
  let calls = 0
  const accessor = { get dangerous() { calls++; return 'bad' } }
  const cycle = {}; cycle.self = cycle
  const nonWire = [accessor, cycle, () => { calls++ }, { toJSON() { calls++; return {} } }, new Date(), new Map(), NaN, Infinity, 1n, Symbol('x')]
  for (const input of nonWire) assert.throws(() => project([{ ...toolStart(), input }]), errorCode('invalid-event'))
  assert.equal(calls, 0)
  const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}')
  const s = project([{ ...toolStart(), input }])
  assert.equal(Object.hasOwn(s.tools[0].input, '__proto__'), true)
  assert.equal(s.tools[0].input.__proto__.polluted, true)
  assert.equal({}.polluted, undefined)
  assert.equal(s.tools[0].input.constructor, 'data')
  const undefinedData = project([{ ...toolStart(), input: { explicit: undefined } }])
  assert.equal(Object.hasOwn(undefinedData.tools[0].input, 'explicit'), true)
  assert.throws(() => appendConversationEvents(undefinedData, [event(1, { ...toolStart(), input: {} })]), errorCode('conflicting-sequence'))
})

const nonTurnKinds = ['message.queued', 'message.cancelled', 'model.changed', 'runtime.notice', 'session.runtime.changed']
for (const kind of nonTurnKinds) {
  for (const turnId of ['phantom', 17]) {
    test(`opaque ${typeof turnId} turnId on ${kind} stays timeline data without fabricating a Turn`, () => {
      const payload = { ...variants.find(v => v.kind === kind), turnId }
      const events = journal([payload])
      const s = projectConversationEvents('s', events)
      assert.deepEqual(s.turns, [])
      assert.deepEqual(s.timeline[0].payload, payload)
      assert.equal(s.lastAppliedSeq, 1)
      assert.equal(appendConversationEvents(s, events), s)
      assert.throws(() => appendConversationEvents(s, [event(1, { ...payload, turnId: 'changed-extension' })]), errorCode('conflicting-sequence'))
      assert.deepEqual(s.turns, [])
    })
  }
}

test('only validated Turn-bearing variants ensure Turns; malformed authoritative turnId remains atomic', () => {
  for (const payload of variants.filter(v => !nonTurnKinds.includes(v.kind))) {
    const s = project([payload])
    assert.deepEqual(s.turns.map(t => t.turnId), ['t'], payload.kind)
    const before = structuredClone(s)
    for (const turnId of [17, null, '', {}, []]) {
      assert.throws(() => appendConversationEvents(s, [event(2, queued()), event(3, { ...payload, turnId })]), errorCode('invalid-event'), payload.kind)
      assert.deepEqual(s, before)
    }
  }
})

for (const streamKind of ['file_change_output', 17]) {
  test(`opaque ${typeof streamKind} streamKind on tool.finished cannot change tool classification`, () => {
    for (const classifiedBy of ['tool.started', 'tool.output.delta', 'neither']) {
      const prior = classifiedBy === 'tool.started' ? [toolStart()]
        : classifiedBy === 'tool.output.delta' ? [toolOutput('out')] : []
      const payload = { ...toolFinish(0), streamKind }
      const events = journal([...prior, payload])
      const s = projectConversationEvents('s', events)
      assert.equal(s.tools[0].streamKind, classifiedBy === 'neither' ? undefined : 'command_output')
      assert.equal(s.tools[0].state, 'completed')
      assert.deepEqual(s.timeline.at(-1).payload, payload)
      assert.equal(appendConversationEvents(s, events), s)
      assert.deepEqual(appendConversationEvents(project(prior), events.slice(prior.length)), s)
    }
    const s = project([toolStart(), { ...toolOutput('file'), streamKind: 'file_change_output' }, { ...toolFinish(null), streamKind }])
    assert.equal(s.tools[0].streamKind, 'file_change_output')
    assert.equal(s.tools[0].outputChunks[0].streamKind, 'file_change_output')
    assert.equal(s.tools[0].state, 'finished')
  })
}
