import type { SessionId, TurnId } from './ids.js'
import type { ModelId, Timestamp } from './values.js'

/** The only public conversation profile exposed by a Worker. */
export const WEMUX_ADK_PROFILE_V1 = 'wemux.adk.v1' as const
export type WemuxAdkProfile = typeof WEMUX_ADK_PROFILE_V1
export const WEMUX_ADK_PROFILES = [WEMUX_ADK_PROFILE_V1] as const

export type RuntimeSessionId = SessionId
export type RuntimeOperationId = TurnId
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
