import type {
  ApprovalId,
  CommandId,
  RuntimeOperationId,
  SessionExecutionSpec,
  SessionId,
  TurnId,
  UserMessageInput,
  WorkspaceId,
  WorkspaceProvisionSpec,
} from '@wemux/domain'
import type { CapabilityRuntimePayload } from './capabilities.js'

export type WorkerCommand =
  | {
      readonly kind: 'workspace.provision'
      readonly workspace: WorkspaceProvisionSpec
    }
  | {
      readonly kind: 'workspace.delete'
      readonly workspaceId: WorkspaceId
    }
  | {
      readonly kind: 'session.create'
      readonly session: SessionExecutionSpec
    }
  | {
      readonly kind: 'session.enqueue'
      readonly sessionId: SessionId
      readonly message: UserMessageInput
      readonly capabilities?: CapabilityRuntimePayload
    }
  | {
      readonly kind: 'session.cancel-queued'
      readonly sessionId: SessionId
      readonly submissionCommandId: CommandId
    }
  | {
      readonly kind: 'session.delete'
      readonly sessionId: SessionId
    }
  | {
      readonly kind: 'turn.stop'
      readonly sessionId: SessionId
      readonly turnId: TurnId
    }
  | {
      readonly kind: 'runtime.command'
      readonly sessionId: SessionId
      readonly operationId: RuntimeOperationId
      readonly name: 'compact' | 'set_model' | 'set_thinking_level'
      readonly arguments: Readonly<Record<string, unknown>>
    }
  | {
      readonly kind: 'runtime.approval.resolve'
      readonly sessionId: SessionId
      readonly approvalId: ApprovalId
      readonly decision: 'approve' | 'deny'
    }

export interface CommandError {
  readonly code:
    | 'conflicting-command'
    | 'not-found'
    | 'invalid-state'
    | 'agent-unavailable'
    | 'invalid-input'
    | 'internal-error'
  readonly message: string
  readonly retryable: boolean
}

/** Accepted means durably recorded by Worker, not that the work completed. */
export type CommandReceipt =
  | { readonly commandId: CommandId; readonly status: 'accepted' }
  | {
      readonly commandId: CommandId
      readonly status: 'rejected'
      readonly error: CommandError
    }
