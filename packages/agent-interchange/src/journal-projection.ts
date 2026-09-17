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
  if (text) return { kind: 'assistant.text.delta', turnId, text }
  if (event.customMetadata?.wemux?.usage) return { kind: 'usage.updated', turnId, usage: event.customMetadata.wemux.usage }

  const provider = event.customMetadata?.provider
  if (!provider || typeof provider.kind !== 'string') return null
  switch (provider.kind) {
    case 'tool.started':
      return { kind: 'tool.started', turnId, toolCallId: provider.toolCallId as ToolCallId, toolName: String(provider.toolName), input: provider.input }
    case 'tool.output.delta':
      return { kind: 'tool.output.delta', turnId, toolCallId: provider.toolCallId as ToolCallId, text: String(provider.text ?? '') }
    case 'tool.finished':
      return { kind: 'tool.finished', turnId, toolCallId: provider.toolCallId as ToolCallId, exitCode: typeof provider.exitCode === 'number' ? provider.exitCode : null }
    case 'approval.requested':
      return {
        kind: 'approval.requested',
        turnId,
        approvalId: provider.approvalId as ApprovalId,
        action: provider.action,
        ...(typeof provider.reason === 'string' ? { reason: provider.reason } : {}),
      }
    case 'compaction.started':
      return { kind: 'compaction.started', turnId, ...(typeof provider.reason === 'string' ? { reason: provider.reason } : {}) }
    case 'compaction.finished':
      return { kind: 'compaction.finished', turnId, ...(typeof provider.summary === 'string' ? { summary: provider.summary } : {}) }
    default:
      return null
  }
}
