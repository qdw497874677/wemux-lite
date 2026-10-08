import type { ConversationEvent } from '@wemux/web-contract'

export type ConversationTextStream = 'assistant_text' | 'reasoning_text' | 'plan_text'
export type ConversationToolStream = 'command_output' | 'file_change_output'
export type ConversationRuntimeState = 'idle' | 'queued' | 'running' | 'stopping' | 'unavailable' | 'failed'
export type ConversationTurnOutcome = 'completed' | 'cancelled' | 'failed'
export interface ConversationTurnFailure {
  readonly code: 'interrupted' | 'agent-unavailable' | 'agent-error' | 'internal-error'
  readonly message: string
  readonly abortReason?: 'user_stop' | 'executor_disconnected' | 'control_plane_disconnect' | 'timeout' | 'provider_error' | 'cancelled' | 'unknown'
  readonly failureReason?: `agent_error.${'context_overflow' | 'missing_config' | 'provider_auth_or_access' | 'provider_quota_limit' | 'provider_capacity_or_rate_limit' | 'provider_server_error' | 'provider_network' | 'model_not_found_or_unavailable' | 'empty_or_unparseable_output' | 'agent_timeout' | 'runtime_missing_executable' | 'runtime_version_unsupported' | 'process_failure' | 'unknown'}`
  readonly retryable?: boolean
}
export interface ConversationUsage {
  readonly scope?: 'message' | 'operation' | 'native-session'
  readonly subjectId?: string
  readonly source?: 'runtime'
  readonly revision?: number
  readonly completeness?: 'complete' | 'partial'
  readonly modelId?: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly totalTokens?: number
  readonly costUsd?: number
  readonly currency?: 'USD'
}
/** Unbranded read types follow domain/journal.ts; these are not a second wire protocol. */
export type ConversationJournalPayload =
  | { readonly kind: 'message.queued'; readonly commandId: string; readonly messageId: string; readonly content: string; readonly position: number; readonly sentByAccountId?: string }
  | { readonly kind: 'message.cancelled'; readonly commandId: string; readonly messageId: string }
  | { readonly kind: 'turn.started'; readonly turnId: string; readonly messageId: string; readonly modelId?: string | null }
  | { readonly kind: 'assistant.text.delta'; readonly turnId: string; readonly text: string; readonly streamKind?: ConversationTextStream }
  | { readonly kind: 'tool.started'; readonly turnId: string; readonly toolCallId: string; readonly toolName: string; readonly input: unknown; readonly streamKind?: ConversationToolStream }
  | { readonly kind: 'tool.output.delta'; readonly turnId: string; readonly toolCallId: string; readonly text: string; readonly streamKind?: ConversationToolStream }
  | { readonly kind: 'tool.finished'; readonly turnId: string; readonly toolCallId: string; readonly exitCode: number | null }
  | { readonly kind: 'approval.requested'; readonly turnId: string; readonly approvalId: string; readonly action: unknown; readonly reason?: string }
  | { readonly kind: 'approval.expired'; readonly turnId: string; readonly approvalId: string; readonly reason: 'timeout' | 'cancelled' | 'turn_released' | 'shutdown' }
  | { readonly kind: 'approval.resolved'; readonly turnId: string; readonly approvalId: string; readonly decision: 'approve' | 'deny'; readonly decidedByAccountId?: string }
  | { readonly kind: 'usage.updated'; readonly turnId: string; readonly usage: ConversationUsage }
  | { readonly kind: 'compaction.started'; readonly turnId: string; readonly reason?: string }
  | { readonly kind: 'compaction.finished'; readonly turnId: string; readonly summary?: string }
  | { readonly kind: 'turn.finished'; readonly turnId: string; readonly outcome: ConversationTurnOutcome; readonly failure: ConversationTurnFailure | null }
  | { readonly kind: 'model.changed'; readonly previousModelId: string | null; readonly modelId: string }
  | { readonly kind: 'runtime.notice'; readonly level: 'info' | 'warning'; readonly code: string; readonly message: string; readonly retry?: { readonly attempt: number; readonly maxAttempts: number | null; readonly delayMs: number | null } }
  | { readonly kind: 'session.runtime.changed'; readonly state: ConversationRuntimeState; readonly reason: string | null }

export interface ConversationEventOrigin { readonly seq: number; readonly occurredAt: string }
export type ConversationTimelineEntry = ConversationEventOrigin & (
  | { readonly kind: 'event'; readonly payload: ConversationJournalPayload }
  | { readonly kind: 'unsupported'; readonly payload: ConversationEvent['payload'] }
)
export interface ConversationMessage extends ConversationEventOrigin {
  readonly messageId: string
  readonly commandId: string
  readonly content: string
  readonly position: number
  readonly sentByAccountId?: string
  readonly state: 'queued' | 'claimed' | 'cancelled'
  readonly turnId: string | null
  readonly cancellationCommandId: string | null
}
export interface ConversationTurn {
  /** Absent for legacy history; never infer from current Session selection. */
  readonly modelId?: string | null
  readonly turnId: string
  readonly messageId: string | null
  readonly started: ConversationEventOrigin | null
  readonly finished: ConversationEventOrigin | null
  readonly state: 'unknown' | 'running' | ConversationTurnOutcome
  readonly failure: ConversationTurnFailure | null
}
export interface ConversationTextSegment extends ConversationEventOrigin {
  readonly turnId: string
  readonly streamKind: ConversationTextStream
  readonly text: string
  readonly throughSeq: number
}
export interface ConversationTool extends ConversationEventOrigin {
  readonly turnId: string
  readonly toolCallId: string
  readonly toolName: string | null
  readonly input: unknown
  readonly started: boolean
  readonly streamKind?: ConversationToolStream
  readonly output: string
  readonly outputChunks: readonly (ConversationEventOrigin & { readonly text: string; readonly streamKind?: ConversationToolStream })[]
  /** null exitCode is an explicit finish with unknown success, never invented success. */
  readonly state: 'unknown' | 'running' | 'completed' | 'failed' | 'finished'
  readonly exitCode: number | null
  readonly finished: ConversationEventOrigin | null
}
export interface ConversationApproval extends ConversationEventOrigin {
  readonly turnId: string
  readonly approvalId: string
  readonly requested: boolean
  readonly action: unknown
  readonly reason?: string
  /** Expiration is not an invented human decision. */
  readonly expired: boolean
  readonly decision: 'approve' | 'deny' | null
  readonly decidedByAccountId?: string
  readonly resolved: ConversationEventOrigin | null
}
export interface ConversationProjection {
  readonly sessionId: string
  /** Last contiguous applied event, not cache freshness or Worker journal head. Starts at zero. */
  readonly lastAppliedSeq: number
  /** Every event, including unsupported kinds, in authoritative sequence order. */
  readonly timeline: readonly ConversationTimelineEntry[]
  readonly messages: readonly ConversationMessage[]
  readonly queuedMessages: readonly ConversationMessage[]
  readonly turns: readonly ConversationTurn[]
  /** Contiguous chunks only: never merge text across tools, notices, or stream kinds. */
  readonly textSegments: readonly ConversationTextSegment[]
  readonly tools: readonly ConversationTool[]
  readonly approvals: readonly ConversationApproval[]
  readonly pendingApprovals: readonly ConversationApproval[]
  /** Latest explicit runtime event only; Turn/approval state is separately observable. */
  readonly runtime: (ConversationEventOrigin & { readonly state: ConversationRuntimeState; readonly reason: string | null }) | null
  readonly model: (ConversationEventOrigin & { readonly previousModelId: string | null; readonly modelId: string }) | null
}

export type ConversationProjectionErrorCode = 'invalid-event' | 'wrong-session' | 'gap' | 'conflicting-sequence'
export class ConversationProjectionError extends Error {
  readonly code: ConversationProjectionErrorCode
  readonly seq: number | null
  constructor(code: ConversationProjectionErrorCode, seq: number | null = null) {
    super(`Conversation journal projection: ${code}${seq === null ? '' : ` at sequence ${seq}`}`)
    this.name = 'ConversationProjectionError'
    this.code = code
    this.seq = seq
  }
}
const invalid = (): never => { throw new ConversationProjectionError('invalid-event') }
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string'
const id = (v: unknown) => text(v) && v.trim().length > 0
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const count = (v: unknown) => number(v) && Number.isSafeInteger(v) && (v as number) >= 0
const member = (...values: readonly string[]) => (v: unknown) => text(v) && values.includes(v)
const optional = (check: (v: unknown) => boolean) => (v: unknown) => v === undefined || check(v)
const nullable = (check: (v: unknown) => boolean) => (v: unknown) => v === null || check(v)
type Shape = Readonly<Record<string, (v: unknown) => boolean>>
const shape = (checks: Shape) => (v: unknown): boolean => record(v) && Object.entries(checks).every(([key, check]) => check(v[key]))
const usage = shape({
  scope: optional(member('message', 'operation', 'native-session')), subjectId: optional(text), source: optional(member('runtime')),
  revision: optional(count), completeness: optional(member('complete', 'partial')), modelId: optional(id),
  inputTokens: optional(count), outputTokens: optional(count), cacheReadTokens: optional(count), cacheWriteTokens: optional(count),
  totalTokens: optional(count), costUsd: optional(v => number(v) && (v as number) >= 0), currency: optional(member('USD')),
})
const failure = shape({
  code: member('interrupted', 'agent-unavailable', 'agent-error', 'internal-error'), message: text,
  abortReason: optional(member('user_stop', 'executor_disconnected', 'control_plane_disconnect', 'timeout', 'provider_error', 'cancelled', 'unknown')),
  failureReason: optional(member(...['context_overflow', 'missing_config', 'provider_auth_or_access', 'provider_quota_limit', 'provider_capacity_or_rate_limit', 'provider_server_error', 'provider_network', 'model_not_found_or_unavailable', 'empty_or_unparseable_output', 'agent_timeout', 'runtime_missing_executable', 'runtime_version_unsupported', 'process_failure', 'unknown'].map(reason => `agent_error.${reason}`))),
  retryable: optional(v => typeof v === 'boolean'),
})
const toolStream = optional(member('command_output', 'file_change_output'))
// Known variants are validated before the discriminated type is exposed. Unknown fields remain data.
const payloadChecks: Record<ConversationJournalPayload['kind'], (v: unknown) => boolean> = {
  'message.queued': shape({ commandId: id, messageId: id, content: text, position: count, sentByAccountId: optional(id) }),
  'message.cancelled': shape({ commandId: id, messageId: id }),
  'turn.started': shape({ turnId: id, messageId: id, modelId: optional(nullable(id)) }),
  'assistant.text.delta': shape({ turnId: id, text, streamKind: optional(member('assistant_text', 'reasoning_text', 'plan_text')) }),
  'tool.started': v => shape({ turnId: id, toolCallId: id, toolName: id, streamKind: toolStream })(v) && record(v) && Object.hasOwn(v, 'input'),
  'tool.output.delta': shape({ turnId: id, toolCallId: id, text, streamKind: toolStream }),
  'tool.finished': shape({ turnId: id, toolCallId: id, exitCode: nullable(v => number(v) && Number.isSafeInteger(v)) }),
  'approval.requested': v => shape({ turnId: id, approvalId: id, reason: optional(text) })(v) && record(v) && Object.hasOwn(v, 'action'),
  'approval.expired': shape({ turnId: id, approvalId: id, reason: member('timeout', 'cancelled', 'turn_released', 'shutdown') }),
  'approval.resolved': shape({ turnId: id, approvalId: id, decision: member('approve', 'deny'), decidedByAccountId: optional(id) }),
  'usage.updated': shape({ turnId: id, usage }),
  'compaction.started': shape({ turnId: id, reason: optional(text) }),
  'compaction.finished': shape({ turnId: id, summary: optional(text) }),
  'turn.finished': shape({ turnId: id, outcome: member('completed', 'cancelled', 'failed'), failure: nullable(failure) }),
  'model.changed': shape({ previousModelId: nullable(id), modelId: id }),
  'runtime.notice': shape({ level: member('info', 'warning'), code: id, message: text, retry: optional(shape({ attempt: count, maxAttempts: nullable(count), delayMs: nullable(v => number(v) && (v as number) >= 0) })) }),
  'session.runtime.changed': shape({ state: member('idle', 'queued', 'running', 'stopping', 'unavailable', 'failed'), reason: nullable(text) }),
}
function validatedPayload(payload: ConversationEvent['payload'], seq: number): ConversationJournalPayload | null {
  if (!Object.hasOwn(payloadChecks, payload.kind)) return null
  const kind = payload.kind as ConversationJournalPayload['kind']
  if (!payloadChecks[kind](payload)) throw new ConversationProjectionError('invalid-event', seq)
  return payload as ConversationEvent['payload'] & ConversationJournalPayload
}

/** Copy/freeze wire data, without invoking getters, toJSON, or retaining mutable input references.
 * Non-wire values (cycles, functions, class instances, nonfinite numbers) are rejected, not coerced.
 * Undefined is allowed for optional fields and unknown local data; it is not silently dropped.
 */
function copyData(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || value === undefined || text(value) || typeof value === 'boolean' || number(value)) return value
  if (typeof value !== 'object' || ancestors.has(value)) return invalid()
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return invalid()
  ancestors.add(value)
  const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {}
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue
    if (typeof key !== 'string') return invalid()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!('value' in descriptor) || !descriptor.enumerable) return invalid()
    Object.defineProperty(result, key, { value: copyData(descriptor.value, ancestors), enumerable: true })
  }
  if (Array.isArray(value) && (result as unknown[]).length !== value.length) return invalid()
  ancestors.delete(value)
  return Object.freeze(result)
}
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!record(a) && !Array.isArray(a)) return false
  if (!record(b) && !Array.isArray(b)) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = Object.keys(a), right = Object.keys(b)
  return left.length === right.length && left.every(key => Object.hasOwn(b, key) && sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}
function entryFromEvent(raw: ConversationEvent, sessionId: string): ConversationTimelineEntry {
  const value = copyData(raw)
  if (!record(value) || !id(value.sessionId) || !count(value.seq) || value.seq === 0 || value.seq === Number.MAX_SAFE_INTEGER
    || !text(value.occurredAt) || !Number.isFinite(Date.parse(value.occurredAt)) || !record(value.payload) || !id(value.payload.kind)) return invalid()
  if (value.sessionId !== sessionId) throw new ConversationProjectionError('wrong-session', value.seq as number)
  const payload = value.payload as ConversationEvent['payload']
  const origin = { seq: value.seq as number, occurredAt: value.occurredAt }
  const validated = validatedPayload(payload, origin.seq)
  if (validated === null) return Object.freeze({ ...origin, kind: 'unsupported', payload })
  return Object.freeze({ ...origin, kind: 'event', payload: validated })
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
function project(sessionId: string, timeline: readonly ConversationTimelineEntry[]): ConversationProjection {
  const messages = new Map<string, Mutable<ConversationMessage>>()
  const turns = new Map<string, Mutable<ConversationTurn>>()
  const tools: Mutable<ConversationTool>[] = []
  const approvals: Mutable<ConversationApproval>[] = []
  const textSegments: Mutable<ConversationTextSegment>[] = []
  let runtime: ConversationProjection['runtime'] = null
  let model: ConversationProjection['model'] = null
  const turn = (turnId: string) => {
    let value = turns.get(turnId)
    if (!value) { value = { turnId, messageId: null, started: null, finished: null, state: 'unknown', failure: null }; turns.set(turnId, value) }
    return value
  }
  for (const entry of timeline) {
    if (entry.kind === 'unsupported') continue
    const p = entry.payload
    const origin = Object.freeze({ seq: entry.seq, occurredAt: entry.occurredAt })
    switch (p.kind) {
      case 'message.queued':
        messages.set(p.messageId, { ...origin, messageId: p.messageId, commandId: p.commandId, content: p.content, position: p.position,
          ...(p.sentByAccountId === undefined ? {} : { sentByAccountId: p.sentByAccountId }), state: 'queued', turnId: null, cancellationCommandId: null })
        break
      case 'message.cancelled': {
        const message = messages.get(p.messageId)
        if (message) { message.state = 'cancelled'; message.cancellationCommandId = p.commandId }
        break
      }
      case 'turn.started': {
        if (!turn(p.turnId).started) Object.assign(turn(p.turnId), { messageId: p.messageId, started: origin, state: 'running', ...(p.modelId === undefined ? {} : { modelId: p.modelId }) })
        const message = messages.get(p.messageId)
        if (message) { message.state = 'claimed'; message.turnId = p.turnId }
        break
      }
      case 'turn.finished':
        Object.assign(turn(p.turnId), { finished: origin, state: p.outcome, failure: p.failure })
        for (const approval of approvals) if (approval.turnId === p.turnId && approval.decision === null) approval.expired = true
        break
      case 'assistant.text.delta': {
        turn(p.turnId)
        const streamKind = p.streamKind ?? 'assistant_text'
        const last = textSegments.at(-1)
        if (last && last.throughSeq === entry.seq - 1 && last.turnId === p.turnId && last.streamKind === streamKind) {
          last.text += p.text; last.throughSeq = entry.seq
        } else textSegments.push({ ...origin, turnId: p.turnId, streamKind, text: p.text, throughSeq: entry.seq })
        break
      }
      case 'tool.started':
      case 'tool.output.delta':
      case 'tool.finished': {
        turn(p.turnId)
        let tool = tools.find(t => t.turnId === p.turnId && t.toolCallId === p.toolCallId)
        if (!tool) {
          tool = { ...origin, turnId: p.turnId, toolCallId: p.toolCallId, toolName: null, input: undefined, started: false, output: '', outputChunks: [], state: 'unknown', exitCode: null, finished: null }
          tools.push(tool)
        }
        if (p.kind === 'tool.started') {
          Object.assign(tool, { toolName: p.toolName, input: p.input, started: true, state: 'running' })
        } else if (p.kind === 'tool.output.delta') {
          tool.output += p.text
          tool.outputChunks = [...tool.outputChunks, Object.freeze({ ...origin, text: p.text, ...(p.streamKind === undefined ? {} : { streamKind: p.streamKind }) })]
        } else {
          tool.exitCode = p.exitCode; tool.finished = origin
          tool.state = p.exitCode === null ? 'finished' : p.exitCode === 0 ? 'completed' : 'failed'
        }
        // Only start/output define streamKind; finish extensions remain opaque timeline data.
        if ((p.kind === 'tool.started' || p.kind === 'tool.output.delta') && p.streamKind !== undefined) tool.streamKind = p.streamKind
        break
      }
      case 'approval.requested':
      case 'approval.expired':
      case 'approval.resolved': {
        turn(p.turnId)
        let approval = approvals.find(a => a.turnId === p.turnId && a.approvalId === p.approvalId)
        if (!approval) {
          approval = { ...origin, turnId: p.turnId, approvalId: p.approvalId, requested: false, expired: !!turn(p.turnId).finished, action: undefined, decision: null, resolved: null }
          approvals.push(approval)
        }
        if (p.kind === 'approval.requested' && !approval.requested) {
          Object.assign(approval, origin)
          approval.requested = true; approval.action = p.action
          if (p.reason !== undefined) approval.reason = p.reason
        } else if (p.kind === 'approval.expired' && approval.requested && !approval.expired && approval.decision === null) {
          approval.expired = true
        } else if (p.kind === 'approval.resolved' && approval.requested && !approval.expired && approval.decision === null) {
          approval.decision = p.decision; approval.resolved = origin
          if (p.decidedByAccountId !== undefined) approval.decidedByAccountId = p.decidedByAccountId
        }
        break
      }
      case 'session.runtime.changed': runtime = Object.freeze({ ...origin, state: p.state, reason: p.reason }); break
      case 'model.changed': model = Object.freeze({ ...origin, previousModelId: p.previousModelId, modelId: p.modelId }); break
      // These are ordered facts, not counters to sum or implicit lifecycle transitions.
      case 'usage.updated':
      case 'compaction.started':
      case 'compaction.finished':
        turn(p.turnId)
        break
      case 'runtime.notice': break
    }
  }
  const frozenMessages = Object.freeze([...messages.values()].map(m => Object.freeze(m)))
  const frozenApprovals = Object.freeze(approvals.map(a => Object.freeze(a)))
  return Object.freeze({
    sessionId, lastAppliedSeq: timeline.at(-1)?.seq ?? 0, timeline: Object.freeze([...timeline]),
    messages: frozenMessages, queuedMessages: Object.freeze(frozenMessages.filter(m => m.state === 'queued')),
    turns: Object.freeze([...turns.values()].map(t => Object.freeze(t))), textSegments: Object.freeze(textSegments.map(s => Object.freeze(s))),
    tools: Object.freeze(tools.map(t => Object.freeze({ ...t, outputChunks: Object.freeze(t.outputChunks) }))),
    approvals: frozenApprovals, pendingApprovals: Object.freeze(frozenApprovals.filter(a => a.requested && !a.expired && a.decision === null)), runtime, model,
  })
}

export function createConversationProjection(sessionId: string): ConversationProjection {
  if (!id(sessionId)) return invalid()
  return project(sessionId, [])
}

/** Atomically append an ordered page to a snapshot produced by this module.
 * New sequences must be contiguous from 1; pages are never sorted or gap-buffered.
 * Replays at any already-applied sequence are no-ops only when timestamp and the entire
 * payload match structurally (object key order is irrelevant; extra fields are significant).
 * Conflicting replays, malformed known payloads, gaps, and wrong Sessions throw without
 * changing the previous snapshot. Unknown kinds advance the cursor as explicit unsupported
 * entries, not interpreted success. Retain/replace the returned snapshot only on success.
 */
export function appendConversationEvents(previous: ConversationProjection, events: readonly ConversationEvent[]): ConversationProjection {
  const timeline = [...previous.timeline]
  for (const event of events) {
    const entry = entryFromEvent(event, previous.sessionId)
    if (entry.seq <= timeline.length) {
      if (!sameData(timeline[entry.seq - 1], entry)) throw new ConversationProjectionError('conflicting-sequence', entry.seq)
    } else {
      if (entry.seq !== timeline.length + 1) throw new ConversationProjectionError('gap', entry.seq)
      timeline.push(entry)
    }
  }
  return timeline.length === previous.timeline.length ? previous : project(previous.sessionId, timeline)
}

export function projectConversationEvents(sessionId: string, events: readonly ConversationEvent[]): ConversationProjection {
  return appendConversationEvents(createConversationProjection(sessionId), events)
}
