import type { ApprovalId, SessionEventPayload, ToolCallId, TurnId } from '@wemux/domain'
import type { AgentEvent } from './event.js'

/**
 * Projects the public Wemux ADK Profile into the durable Session Journal.
 *
 * This is intentionally one-way: Journal events are a product read model, not a
 * second Agent protocol. Provider-native records must first become AgentEvent.
 */
export function projectAgentEventToSessionPayload(event: AgentEvent, turnId: TurnId): SessionEventPayload | null {
  const text = event.content?.parts.map(part => 'text' in part ? part.text : '').join('')
  if (text) return {
    kind: 'assistant.text.delta',
    turnId,
    text,
    ...(event.streamKind === 'assistant_text' || event.streamKind === 'reasoning_text' || event.streamKind === 'plan_text' ? { streamKind: event.streamKind } : {}),
  }
  if (event.customMetadata?.wemux?.usage) return { kind: 'usage.updated', turnId, usage: event.customMetadata.wemux.usage }

  const terminal = event.customMetadata?.wemux?.terminal
  if (terminal) {
    const error = event.customMetadata?.wemux?.error
    return {
      kind: 'turn.finished',
      turnId,
      outcome: terminal,
      failure: terminal === 'failed'
        ? {
            code: error?.code ?? 'agent-error',
            message: error?.message ?? 'Agent failed',
            ...(error?.abortReason ? { abortReason: error.abortReason } : {}),
            ...(error?.failureReason ? { failureReason: error.failureReason } : {}),
            ...(error?.retryable !== undefined ? { retryable: error.retryable } : {}),
          }
        : null,
    }
  }

  const provider = event.customMetadata?.provider
  if (!provider || typeof provider.kind !== 'string') return null
  switch (provider.kind) {
    case 'tool.started':
      return { kind: 'tool.started', turnId, toolCallId: provider.toolCallId as ToolCallId, toolName: String(provider.toolName), input: provider.input, ...(event.streamKind === 'command_output' || event.streamKind === 'file_change_output' ? { streamKind: event.streamKind } : {}) }
    case 'tool.output.delta':
      return { kind: 'tool.output.delta', turnId, toolCallId: provider.toolCallId as ToolCallId, text: String(provider.text ?? ''), ...(event.streamKind === 'command_output' || event.streamKind === 'file_change_output' ? { streamKind: event.streamKind } : {}) }
    case 'tool.finished':
      return { kind: 'tool.finished', turnId, toolCallId: provider.toolCallId as ToolCallId, exitCode: typeof provider.exitCode === 'number' ? provider.exitCode : null }
    case 'approval.requested': {
      const approval = event.customMetadata?.wemux?.approval
      if (approval?.kind === 'requested') return { kind: 'approval.requested', turnId, approvalId: approval.id, action: approval.action, ...(approval.reason ? { reason: approval.reason } : {}) }
      return {
        kind: 'approval.requested',
        turnId,
        approvalId: provider.approvalId as ApprovalId,
        action: provider.action,
        ...(typeof provider.reason === 'string' ? { reason: provider.reason } : {}),
      }
    }
    case 'approval.resolved': {
      const approval = event.customMetadata?.wemux?.approval
      if (approval?.kind !== 'resolved') return null
      return { kind: 'approval.resolved', turnId, approvalId: approval.id, decision: approval.decision }
    }
    case 'compaction.started':
      return { kind: 'compaction.started', turnId, ...(typeof provider.reason === 'string' ? { reason: provider.reason } : {}) }
    case 'compaction.finished':
      return { kind: 'compaction.finished', turnId, ...(typeof provider.summary === 'string' ? { summary: provider.summary } : {}) }
    case 'runtime.notice': {
      const retry = provider.retry && typeof provider.retry === 'object' ? provider.retry as Record<string, unknown> : null
      return {
        kind: 'runtime.notice',
        level: provider.level === 'info' ? 'info' : 'warning',
        code: typeof provider.code === 'string' && provider.code ? provider.code : 'agent.notice',
        message: typeof provider.message === 'string' && provider.message ? provider.message : '运行时提示',
        ...(retry
          ? { retry: { attempt: typeof retry.attempt === 'number' ? retry.attempt : 1, maxAttempts: typeof retry.maxAttempts === 'number' ? retry.maxAttempts : null, delayMs: typeof retry.delayMs === 'number' ? retry.delayMs : null } }
          : {}),
      }
    }
    default:
      return null
  }
}
