import type {
  ProjectId,
  SessionId,
  WorkerId,
  WorkspaceId,
} from './ids.js'
import type { SessionRuntimeState } from './session.js'
import type { AgentKey, ModelId, Timestamp } from './values.js'

export interface WorkerSummary {
  readonly id: WorkerId
  readonly name: string
  readonly status: 'online' | 'offline'
  readonly platform: string
  readonly architecture: string
  readonly lastSeenAt: Timestamp
}

export interface AgentSummary {
  readonly workerId: WorkerId
  readonly key: AgentKey
  readonly name: string
  readonly available: boolean
  readonly executable: string | null
  readonly models: readonly ModelId[]
}

export interface WorkspaceSummary {
  readonly id: WorkspaceId
  readonly projectId: ProjectId
  readonly workerId: WorkerId
  readonly name: string
  readonly repositoryUrl: string | null
  readonly branch: string | null
  readonly status:
    | 'pending'
    | 'provisioning'
    | 'ready'
    | 'failed'
    | 'deleting'
    | 'deleted'
  readonly failureReason: string | null
}

export interface SessionSummary {
  readonly id: SessionId
  readonly workspaceId: WorkspaceId
  readonly workerId: WorkerId
  readonly name: string
  readonly agentKey: AgentKey
  readonly modelId: ModelId
  readonly state: SessionRuntimeState
  readonly queuedMessageCount: number
}
