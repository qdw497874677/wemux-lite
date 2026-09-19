import type { AgentCapability, JournalEvent } from '@wemux/domain'
import type { WorkerToServer } from '@wemux/wire-protocol'
import { AppError } from './errors.js'

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'Expected object')
  return value as Record<string, unknown>
}
export function text(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(400, `Invalid ${name}`)
  return value
}
function streamText(value: unknown, name: string, max = 100000): string {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(JSON.stringify(value)) > max) throw new AppError(400, `Invalid ${name}`)
  return value
}
export function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new AppError(400, `Invalid ${name}`)
  return value
}
function oneOf(value: unknown, choices: readonly string[]): void {
  if (typeof value !== 'string' || !choices.includes(value)) throw new AppError(400, 'Invalid enum value')
}
function boolean(value: unknown): void { if (typeof value !== 'boolean') throw new AppError(400, 'Expected boolean') }
function nullableText(value: unknown): void { if (value !== null) text(value, 'text') }
function timestamp(value: unknown): void { if (!Number.isFinite(Date.parse(text(value, 'timestamp')))) throw new AppError(400, 'Invalid timestamp') }
function array(value: unknown): unknown[] { if (!Array.isArray(value) || value.length > 1000) throw new AppError(400, 'Invalid array'); return value }
function usage(value: unknown): void {
  const u = object(value)
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'] as const) if (u[key] !== undefined) integer(u[key], key, 0)
  if (u.costUsd !== undefined) { if (typeof u.costUsd !== 'number' || !Number.isFinite(u.costUsd) || u.costUsd < 0) throw new AppError(400, 'Invalid costUsd') }
  if (u.modelId !== undefined) text(u.modelId, 'modelId')
  if (u.completeness !== undefined) oneOf(u.completeness, ['complete', 'partial'])
  if (u.scope !== undefined) oneOf(u.scope, ['message', 'operation', 'native-session'])
}
const states = ['idle', 'queued', 'running', 'stopping', 'unavailable', 'failed']
export function validateEvent(value: unknown): JournalEvent {
  const e = object(value)
  text(e.sessionId, 'sessionId'); integer(e.seq, 'seq', 1); timestamp(e.occurredAt)
  const p = object(e.payload)
  switch (p.kind) {
    case 'message.queued': text(p.commandId, 'commandId'); text(p.messageId, 'messageId'); streamText(p.content, 'content', 200000); integer(p.position, 'position'); break
    case 'message.cancelled': text(p.commandId, 'commandId'); text(p.messageId, 'messageId'); break
    case 'turn.started': text(p.turnId, 'turnId'); text(p.messageId, 'messageId'); break
    case 'assistant.text.delta': text(p.turnId, 'turnId'); streamText(p.text, 'text', 200000); break
    case 'tool.started': text(p.turnId, 'turnId'); text(p.toolCallId, 'toolCallId'); text(p.toolName, 'toolName'); break
    case 'tool.output.delta': text(p.turnId, 'turnId'); text(p.toolCallId, 'toolCallId'); streamText(p.text, 'text', 200000); break
    case 'tool.finished': text(p.turnId, 'turnId'); text(p.toolCallId, 'toolCallId'); if (p.exitCode !== null) integer(p.exitCode, 'exitCode', -2147483648, 2147483647); break
    case 'approval.requested': text(p.turnId, 'turnId'); text(p.approvalId, 'approvalId'); object(p.action); if (p.reason !== undefined) text(p.reason, 'reason'); break
    case 'approval.resolved': text(p.turnId, 'turnId'); text(p.approvalId, 'approvalId'); oneOf(p.decision, ['approve', 'deny']); break
    case 'usage.updated': text(p.turnId, 'turnId'); usage(p.usage); break
    case 'compaction.started': text(p.turnId, 'turnId'); if (p.reason !== undefined) text(p.reason, 'reason'); break
    case 'compaction.finished': text(p.turnId, 'turnId'); if (p.summary !== undefined) streamText(p.summary, 'summary', 200000); break
    case 'runtime.notice': {
      oneOf(p.level, ['info', 'warning']); text(p.code, 'code', 200); streamText(p.message, 'message', 4000)
      if (p.retry !== undefined) {
        const r = object(p.retry)
        integer(r.attempt, 'attempt', 1)
        if (r.maxAttempts !== null && r.maxAttempts !== undefined) integer(r.maxAttempts, 'maxAttempts', 1)
        if (r.delayMs !== null && r.delayMs !== undefined) integer(r.delayMs, 'delayMs', 0, 86400000)
      }
      break
    }
    case 'turn.finished': {
      text(p.turnId, 'turnId'); oneOf(p.outcome, ['completed', 'cancelled', 'failed'])
      if (p.failure !== null) { const f = object(p.failure); oneOf(f.code, ['interrupted', 'agent-unavailable', 'agent-error', 'internal-error']); text(f.message, 'failure') }
      break
    }
    case 'session.runtime.changed': oneOf(p.state, states); nullableText(p.reason); break
    default: throw new AppError(400, 'Unknown event kind')
  }
  return value as JournalEvent
}
function capability(value: unknown): AgentCapability {
  const c = object(value)
  text(c.agentKey, 'agentKey'); text(c.displayName, 'displayName'); nullableText(c.version); oneOf(c.mode, ['detect-only', 'execution'])
  const a = object(c.availability); oneOf(a.status, ['available', 'unavailable', 'authentication-required'])
  if (a.status !== 'available') text(a.reason, 'reason')
  if (c.authorization !== undefined) {
    const authorization = object(c.authorization)
    oneOf(authorization.state, ['unknown', 'authorized', 'unauthorized', 'expired'])
    if (authorization.accountLabel !== undefined) text(authorization.accountLabel, 'accountLabel')
    if (authorization.expiresAt !== undefined) timestamp(authorization.expiresAt)
    if (authorization.instructions !== undefined) text(authorization.instructions, 'instructions')
  }
  for (const model of array(c.models)) { const m = object(model); text(m.modelId, 'modelId'); text(m.displayName, 'displayName'); oneOf(m.source, ['detected', 'configured']) }
  return value as AgentCapability
}
export function workerMessage(value: unknown): WorkerToServer {
  const m = object(value)
  switch (m.type) {
    case 'heartbeat': text(m.nonce, 'nonce'); timestamp(m.sentAt); break
    case 'capability': text(m.workerId, 'workerId'); timestamp(m.detectedAt); array(m.capabilities).forEach(capability); break
    case 'ack': {
      const r = object(m.receipt); text(r.commandId, 'commandId'); oneOf(r.status, ['accepted', 'rejected'])
      if (r.status === 'rejected') { const e = object(r.error); oneOf(e.code, ['conflicting-command', 'not-found', 'invalid-state', 'agent-unavailable', 'invalid-input', 'internal-error']); text(e.message, 'message'); boolean(e.retryable) }
      break
    }
    case 'event':
      oneOf(m.scope, ['session', 'workspace'])
      if (m.scope === 'session') validateEvent(m.event)
      else {
        const r = object(m.report); if (r.commandId !== undefined) text(r.commandId, 'commandId'); text(r.workspaceId, 'workspaceId'); oneOf(r.status, ['pending', 'provisioning', 'ready', 'failed', 'deleting', 'deleted']); nullableText(r.reason); timestamp(r.occurredAt)
        if (r.location !== null) {
          const l = object(r.location); text(l.workspaceId, 'workspaceId'); text(l.workerId, 'workerId'); text(l.rootPath, 'rootPath')
          for (const checkout of array(l.checkouts)) { const c = object(checkout); text(c.repositoryId, 'repositoryId'); text(c.absolutePath, 'absolutePath') }
        }
      }
      break
    case 'sync':
      oneOf(m.kind, ['heads', 'batch', 'gap'])
      if (m.kind === 'heads') { boolean(m.complete); for (const head of array(m.heads)) { const h = object(head); text(h.sessionId, 'sessionId'); integer(h.lastSeq, 'lastSeq') } }
      else {
        text(m.sessionId, 'sessionId')
        if (m.kind === 'gap') { integer(m.fromSeq, 'fromSeq', 1); text(m.reason, 'reason') }
        else { integer(m.throughSeq, 'throughSeq'); boolean(m.hasMore); array(m.events).forEach(validateEvent) }
      }
      break
    default: throw new AppError(400, 'Unknown message type')
  }
  return value as WorkerToServer
}
