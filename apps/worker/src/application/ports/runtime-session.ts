import type { ApprovalId, ModelId, NativeSessionRef, RuntimeOperationId, SessionId, UserMessageInput } from '@wemux/domain'
import type { AgentLaunchContext, AgentTurnHandle } from './agent-adapter.js'

export interface RuntimeSessionOpenInput {
  readonly sessionId: SessionId
  readonly cwd: string
  /** Optional: null lets the Agent CLI use its own default model. */
  readonly modelId: ModelId | null
  readonly resume: NativeSessionRef | null
}

export interface RuntimeOperationInput {
  readonly operationId: RuntimeOperationId
  readonly message: UserMessageInput
  readonly launchContext: AgentLaunchContext | null
}

export interface RuntimeCommand {
  readonly operationId: RuntimeOperationId
  readonly name: string
  readonly arguments: Readonly<Record<string, unknown>>
}

/** One provider-native conversation attachment owned by a product Session. */
export interface AgentRuntimeSession {
  execute(input: RuntimeOperationInput): Promise<AgentTurnHandle>
  command(command: RuntimeCommand): Promise<void>
  resolveApproval(approvalId: ApprovalId, decision: 'approve' | 'deny'): Promise<void>
  close(): Promise<void>
}

export interface RuntimeSessionAdapter {
  openSession(input: RuntimeSessionOpenInput): Promise<AgentRuntimeSession>
}
