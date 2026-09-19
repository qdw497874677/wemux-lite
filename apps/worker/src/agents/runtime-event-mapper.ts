import type { ApprovalId, ToolCallId, TurnFailure } from '@wemux/domain'
import type { AgentSignal, AgentTurnEvent } from '../application/ports/agent-adapter.js'
import type { RuntimeOperationInput } from '../application/ports/runtime-session.js'

const text = (value: unknown) => typeof value === 'string' ? value : null
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const count = (value: unknown) => {
  const parsed = number(value)
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}
const assistantText = (record: Record<string, unknown>) => {
  const direct = text(record.text) ?? text(object(record.delta).text) ?? text(object(record.message).content)
  if (direct) return direct
  const piEvent = object(record.assistantMessageEvent)
  if (piEvent.type === 'text_delta') return text(piEvent.delta)
  const content = object(record.message).content
  if (!Array.isArray(content)) return null
  return content.map(item => text(object(item).text) ?? '').join('') || null
}

/**
 * 终止记录里内嵌的 assistant 消息：Pi 把模型错误放在 `stopReason: 'error'` + `errorMessage`
 * 上，content 为空。只看 `is_error`/`status`/`success` 会把「模型拒绝或额度用尽」当成
 * 正常完成，界面上于是什么也没有（历史 P0：发送消息一直没有响应，但回合显示已完成）。
 */
const terminalAssistantMessages = (record: Record<string, unknown>) => {
  const records = Array.isArray(record.messages) ? record.messages : []
  const embedded = Array.isArray(record.messages) ? records : [record.message]
  return embedded
    .map(object)
    .filter(message => message.role === 'assistant')
    .filter(message => Object.keys(message).length > 0)
}

const terminalOutcome = (provider: 'pi' | 'claude', record: Record<string, unknown>): TurnFailure | null => {
  const assistants = terminalAssistantMessages(record)
  const errored = assistants.find(message => text(message.stopReason) === 'error' || text(message.errorMessage))
  if (errored) {
    const detail = text(errored.errorMessage)
    const scope = [text(errored.provider), text(errored.model)].filter(Boolean).join('/')
    const fallback = `${provider} runtime reported an error${scope ? ` for ${scope}` : ''}`
    return { code: 'agent-error', message: detail ?? fallback }
  }
  if (assistants.some(message => text(message.stopReason) === 'aborted')) return null
  if (record.is_error === true || record.status === 'failed' || record.success === false) return { code: 'agent-error', message: text(record.error) ?? text(record.message) ?? `${provider} runtime failed` }
  return null
}

export function mapRuntimeRecord(provider: 'pi' | 'claude', operationId: RuntimeOperationInput['operationId'], record: Record<string, unknown>): AgentSignal[] {
  const type = text(record.type)
  if (type === 'assistant' || type === 'assistant_message' || type === 'text_delta' || type === 'message_update' || (type === 'message_end' && object(record.message).role === 'assistant')) {
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
  if (type === 'usage' || type === 'usage_update' || type === 'message_update' || (type === 'result' && record.usage !== undefined)) {
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
  if (type === 'auto_retry_start') {
    // Pi 遇到 429 冷却或额度限制时会自行退避重试（默认最多 10 次）。不把这件事发出去，
    // 用户在退避期间只能看到一个沉默的「正在处理」。
    return [{
      kind: 'event',
      event: {
        kind: 'runtime.notice',
        level: 'warning',
        code: 'agent.auto-retry',
        message: `运行时错误，正在自动重试：${text(record.errorMessage) ?? '未知错误'}`,
        retry: { attempt: count(record.attempt) ?? 1, maxAttempts: count(record.maxAttempts), delayMs: count(record.delayMs) },
      } as AgentTurnEvent,
    }]
  }
  if (type === 'auto_retry_end') {
    const failed = record.success === false
    return [{
      kind: 'event',
      event: {
        kind: 'runtime.notice',
        level: failed ? 'warning' : 'info',
        code: failed ? 'agent.retry-failed' : 'agent.retry-recovered',
        message: failed ? `自动重试仍然失败：${text(record.finalError) ?? '未知错误'}` : '自动重试成功，继续执行',
        retry: { attempt: count(record.attempt) ?? 1, maxAttempts: null, delayMs: null },
      } as AgentTurnEvent,
    }]
  }
  if (type === 'done' || type === 'result' || type === 'completed' || type === 'turn_end' || type === 'agent_end' || type === 'agent_settled') {
    // Pi 在自动重试时先发 agent_end（willRetry=true）再发 auto_retry_start。此时不能结束
    // 回合：提前收尾会把后续重试产生的正文全部丢掉，只剩下一个空的「已完成」。
    if (record.willRetry === true) return []
    const failure = terminalOutcome(provider, record)
    if (failure) return [{ kind: 'finished', outcome: { status: 'failed', failure } }]
    if (terminalAssistantMessages(record).some(message => text(message.stopReason) === 'aborted')) return [{ kind: 'finished', outcome: { status: 'cancelled' } }]
    return [{ kind: 'finished', outcome: { status: 'completed' } }]
  }
  if (type === 'error' || (type === 'response' && record.success === false)) return [{ kind: 'finished', outcome: { status: 'failed', failure: { code: 'agent-error', message: text(record.error) ?? text(record.message) ?? `${provider} runtime failed` } } }]
  return []
}
