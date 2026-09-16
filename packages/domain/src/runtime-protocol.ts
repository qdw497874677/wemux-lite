import type { SessionId, TurnId } from './ids.js'
import type { ModelId, Timestamp } from './values.js'

export type RuntimeProtocolVersion = 2
export type RuntimeSessionId = SessionId
export type RuntimeOperationId = TurnId
export type RuntimeEventSequence = number & { readonly __brand: 'RuntimeEventSequence' }
export type ApprovalId = string & { readonly __brand: 'ApprovalId' }

export interface RuntimeUsage {
  readonly scope?: 'message' | 'operation' | 'native-session'
  readonly subjectId?: string
  readonly source?: 'runtime'
  readonly revision?: number
  readonly completeness?: 'complete' | 'partial'
  readonly modelId?: ModelId
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly totalTokens?: number
  readonly costUsd?: number
  readonly currency?: 'USD'
}

export interface RuntimeErrorInfo {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly retryAfterMs?: number
  readonly details?: Readonly<Record<string, unknown>>
}

export interface RuntimeAuthorization {
  readonly state: 'unknown' | 'authorized' | 'unauthorized' | 'expired'
  readonly accountLabel?: string
  readonly expiresAt?: Timestamp
  readonly instructions?: string
}

export interface CommandDescriptor {
  readonly name: string
  readonly title: string
  readonly description?: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly requiresApproval?: boolean
}

export interface ApprovalRequest {
  readonly id: ApprovalId
  readonly title: string
  readonly description: string
  readonly status: 'pending' | 'approved' | 'denied' | 'expired'
  readonly expiresAt?: Timestamp
  readonly metadata?: Readonly<Record<string, unknown>>
}

interface RuntimeEventBase {
  readonly version: RuntimeProtocolVersion
  readonly operationId: RuntimeOperationId
  readonly sessionId: RuntimeSessionId
  readonly sequence: RuntimeEventSequence
  readonly occurredAt: Timestamp
}

export type RuntimeEvent =
  | (RuntimeEventBase & { readonly type: 'text_delta'; readonly text: string })
  | (RuntimeEventBase & { readonly type: 'reasoning_delta'; readonly text: string })
  | (RuntimeEventBase & { readonly type: 'operation_status'; readonly status: 'queued' | 'running' | 'stopping' | 'completed' | 'failed' | 'cancelled'; readonly message?: string })
  | (RuntimeEventBase & { readonly type: 'command_catalog'; readonly commands: readonly CommandDescriptor[] })
  | (RuntimeEventBase & { readonly type: 'approval_required'; readonly approval: ApprovalRequest })
  | (RuntimeEventBase & { readonly type: 'usage'; readonly usage: RuntimeUsage })
  | (RuntimeEventBase & { readonly type: 'authorization'; readonly authorization: RuntimeAuthorization })
  | (RuntimeEventBase & { readonly type: 'error'; readonly error: RuntimeErrorInfo })
  | (RuntimeEventBase & { readonly type: 'completed'; readonly status: 'succeeded' | 'failed' | 'cancelled'; readonly usage?: RuntimeUsage; readonly error?: RuntimeErrorInfo })

export interface RuntimeSessionDescriptor {
  readonly sessionId: RuntimeSessionId
  readonly modelId: ModelId
  readonly authorization: RuntimeAuthorization
  readonly commands: readonly CommandDescriptor[]
}
