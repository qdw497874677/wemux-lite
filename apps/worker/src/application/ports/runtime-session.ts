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
  /**
   * 可选的同步强制终止：立即杀掉 provider 子进程，不等待任何 promise。
   * 用于 close() 本身可能挂死（子进程僵死/管道卡住）时的兜底，
   * 让挂起的 execute 迭代器因进程退出而结束。必须是同步的。
   */
  kill?(): void
}

export interface RuntimeSessionAdapter {
  openSession(input: RuntimeSessionOpenInput): Promise<AgentRuntimeSession>
}
