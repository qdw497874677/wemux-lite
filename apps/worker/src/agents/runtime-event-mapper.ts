import type { ApprovalId, ToolCallId } from '@wemux/domain'
import type { AgentSignal, AgentTurnEvent } from '../application/ports/agent-adapter.js'
import type { RuntimeOperationInput } from '../application/ports/runtime-session.js'

const text = (value: unknown) => typeof value === 'string' ? value : null
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const assistantText = (record: Record<string, unknown>) => {
  const direct = text(record.text) ?? text(object(record.delta).text) ?? text(object(record.message).content)
  if (direct) return direct
  const piEvent = object(record.assistantMessageEvent)
  if (piEvent.type === 'text_delta') return text(piEvent.delta)
  const content = object(record.message).content
  if (!Array.isArray(content)) return null
  return content.map(item => text(object(item).text) ?? '').join('') || null
}

export function mapRuntimeRecord(provider: 'pi' | 'claude', operationId: RuntimeOperationInput['operationId'], record: Record<string, unknown>): AgentSignal[] {
  const type = text(record.type)
  if (type === 'assistant' || type === 'assistant_message' || type === 'text_delta' || type === 'message_update') {
    const value = assistantText(record)
    return value ? [{ kind: 'event', event: { kind: 'assistant.text.delta', text: value } }] : []
  }
  if (type === 'tool_execution_start' || type === 'tool_use') {
    const toolCallId = (text(record.toolCallId) ?? text(record.id) ?? `${provider}-${operationId}-tool`) as ToolCallId
    return [{ kind: 'event', event: { kind: 'tool.started', toolCallId, toolName: text(record.toolName) ?? text(record.name) ?? 'tool', input: record.args ?? record.input ?? null } }]
  }
  if (type === 'tool_execution_update' || type === 'tool_result_delta') {
    const toolCallId = (text(record.toolCallId) ?? text(record.id) ?? `${provider}-${operationId}-tool`) as ToolCallId
    return [{ kind: 'event', event: { kind: 'tool.output.delta', toolCallId, text: text(record.output) ?? text(record.text) ?? '' } }]
  }
  if (type === 'tool_execution_end' || type === 'tool_result') {
    const toolCallId = (text(record.toolCallId) ?? text(record.id) ?? `${provider}-${operationId}-tool`) as ToolCallId
    return [{ kind: 'event', event: { kind: 'tool.finished', toolCallId, exitCode: number(record.exitCode) ?? (record.is_error === true ? 1 : 0) } }]
  }
  if (type === 'approval_required') {
    const event = { kind: 'approval.requested', approvalId: (text(record.approvalId) ?? text(record.id) ?? `${provider}-${operationId}-approval`) as ApprovalId, action: record.action ?? record.input ?? null, reason: text(record.reason) ?? undefined } as AgentTurnEvent
    return [{ kind: 'event', event }]
  }
  if (type === 'usage' || type === 'usage_update' || (type === 'result' && record.usage !== undefined)) {
    const raw = Object.keys(object(record.usage)).length > 0 ? object(record.usage) : record
    const usage = { inputTokens: number(raw.inputTokens ?? raw.input_tokens ?? raw.input), outputTokens: number(raw.outputTokens ?? raw.output_tokens ?? raw.output), cacheReadTokens: number(raw.cacheReadTokens ?? raw.cache_read_input_tokens ?? raw.cacheRead), cacheWriteTokens: number(raw.cacheWriteTokens ?? raw.cache_creation_input_tokens ?? raw.cacheWrite), totalTokens: number(raw.totalTokens ?? raw.total_tokens), costUsd: number(record.costUsd ?? record.cost_usd) }
    if (usage.totalTokens === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) usage.totalTokens = usage.inputTokens + usage.outputTokens
    const normalized = {
      scope: 'operation' as const,
      subjectId: operationId,
      source: 'runtime' as const,
      revision: 1,
      completeness: usage.inputTokens !== undefined && usage.outputTokens !== undefined ? 'complete' as const : 'partial' as const,
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
      ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd, currency: 'USD' as const } : {}),
    }
    const signals: AgentSignal[] = [{ kind: 'event', event: { kind: 'usage.updated', usage: normalized } as AgentTurnEvent }]
    if (type === 'result') signals.push({ kind: 'finished', outcome: record.is_error === true || record.status === 'failed' ? { status: 'failed', failure: { code: 'agent-error', message: text(record.error) ?? text(record.message) ?? `${provider} runtime failed` } } : { status: 'completed' } })
    return signals
  }
  if (type === 'auto_compaction_start' || type === 'compaction_started') return [{ kind: 'event', event: { kind: 'compaction.started', reason: text(record.reason) ?? undefined } as AgentTurnEvent }]
  if (type === 'auto_compaction_end' || type === 'compaction_finished') return [{ kind: 'event', event: { kind: 'compaction.finished', summary: text(record.summary) ?? undefined } as AgentTurnEvent }]
  if (type === 'done' || type === 'result' || type === 'completed' || type === 'turn_end' || type === 'agent_end' || type === 'agent_settled') return [{ kind: 'finished', outcome: record.is_error === true || record.status === 'failed' || record.success === false ? { status: 'failed', failure: { code: 'agent-error', message: text(record.error) ?? text(record.message) ?? `${provider} runtime failed` } } : { status: 'completed' } }]
  if (type === 'error') return [{ kind: 'finished', outcome: { status: 'failed', failure: { code: 'agent-error', message: text(record.message) ?? `${provider} runtime failed` } } }]
  return []
}
