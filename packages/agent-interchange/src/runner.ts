import type {
  AgentKey,
  ApprovalId,
  MessageId,
  ModelId,
  NativeSessionRef,
  RuntimeOperationId,
  SessionId,
} from '@wemux/domain'
import type { AgentContent } from './content.js'
import type { AgentEvent } from './event.js'

export interface RunRequest {
  readonly appName: string
  readonly userId: string
  readonly sessionId: SessionId
  readonly invocationId: RuntimeOperationId
  readonly agentKey: AgentKey
  /** Optional: null lets the Agent CLI use its own default model. */
  readonly modelId: ModelId | null
  readonly cwd: string
  readonly messageId: MessageId
  readonly message: AgentContent
  readonly resume: NativeSessionRef | null
  readonly configurationFingerprint: string
  readonly launchContext?: unknown
}

export interface CommandRequest {
  readonly sessionId: SessionId
  readonly invocationId: RuntimeOperationId
  readonly name: string
  readonly arguments: Readonly<Record<string, unknown>>
}

export interface ApprovalDecision {
  readonly sessionId: SessionId
  readonly invocationId?: RuntimeOperationId
  readonly approvalId: ApprovalId
  readonly decision: 'approve' | 'deny'
}

/**
 * The sole external seam of the Agent interchange module.
 * Iteration ending means the invocation and its resources have settled.
 */
export interface AgentRunner {
  run(request: RunRequest): AsyncIterable<AgentEvent>
  command(request: CommandRequest): Promise<void>
  resolveApproval(request: ApprovalDecision): Promise<void>
  closeSession(sessionId: SessionId): Promise<void>
  close(): Promise<void>
}
