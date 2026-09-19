import type {
  AgentCapability,
  CapabilitySnapshot,
  AgentKey,
  ModelId,
  NativeSessionRef,
  SessionId,
  ToolCallId,
  TurnFailure,
  TurnId,
  UserMessageInput,
  ApprovalId,
  RuntimeUsage,
  SessionNoticeRetry,
} from '@wemux/domain'

export interface LocalAgentDetection extends AgentCapability {
  readonly executablePath: string | null
  readonly diagnostics: readonly string[]
}

export interface AgentTurnInput {
  readonly sessionId: SessionId
  readonly turnId: TurnId
  readonly cwd: string
  /** Optional: null lets the Agent CLI use its own default model. */
  readonly modelId: ModelId | null
  readonly message: UserMessageInput
  readonly resume: NativeSessionRef | null
  readonly launchContext: AgentLaunchContext | null
}

export interface AgentLaunchContext {
  readonly assetsRoot: string
  readonly instructions: string | null
  readonly skillsRoot: string | null
  readonly capabilityEndpoint: string | null
  readonly capabilityToken: string | null
  readonly capabilitySnapshot: CapabilitySnapshot
  readonly environment: Readonly<Record<string, string>>
}

export type AgentTurnEvent =
  | { readonly kind: 'assistant.text.delta'; readonly text: string }
  | {
      readonly kind: 'tool.started'
      readonly toolCallId: ToolCallId
      readonly toolName: string
      readonly input: unknown
    }
  | { readonly kind: 'tool.output.delta'; readonly toolCallId: ToolCallId; readonly text: string }
  | {
      readonly kind: 'tool.finished'
      readonly toolCallId: ToolCallId
      readonly exitCode: number | null
    }
  | { readonly kind: 'approval.requested'; readonly approvalId: ApprovalId; readonly action: unknown; readonly reason: string | undefined }
  | { readonly kind: 'usage.updated'; readonly usage: RuntimeUsage }
  | { readonly kind: 'compaction.started'; readonly reason: string | undefined }
  | { readonly kind: 'compaction.finished'; readonly summary: string | undefined }
  | {
      readonly kind: 'runtime.notice'
      readonly level: 'info' | 'warning'
      readonly code: string
      readonly message: string
      readonly retry?: SessionNoticeRetry
    }

export type AgentTurnOutcome =
  | { readonly status: 'completed' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly failure: TurnFailure }

export type AgentSignal =
  | { readonly kind: 'native-session'; readonly nativeSession: NativeSessionRef }
  | { readonly kind: 'event'; readonly event: AgentTurnEvent }
  | { readonly kind: 'finished'; readonly outcome: AgentTurnOutcome }

export interface AgentTurnHandle {
  readonly signals: AsyncIterable<AgentSignal>
  /** Idempotently requests that this Turn stop. */
  stop(): Promise<void>
}

export type AgentAdapter =
  | {
      readonly agentKey: AgentKey
      readonly mode: 'detect-only'
      detect(): Promise<LocalAgentDetection>
    }
  | {
      readonly agentKey: AgentKey
      readonly mode: 'execution'
      detect(): Promise<LocalAgentDetection>
    }
