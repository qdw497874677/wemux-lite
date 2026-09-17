// Web-owned HTTP contract. Adapt backend differences here and in client.ts only.
export interface AgentDTO {
  agentKey: string
  displayName: string
  version: string | null
  mode: 'detect-only' | 'execution'
  availability: { status: 'available' | 'unavailable' | 'authentication-required'; reason?: string }
  models: { modelId: string; displayName: string; source: 'detected' | 'configured' }[]
}
export interface WorkerDTO {
  id: string
  name: string
  connectionState: 'online' | 'offline' | 'revoked'
  version: string | null
  platform: string | null
  capabilities: AgentDTO[]
  lastSeenAt: string | null
}
export interface CreateEnrollmentTokenDTO { ttlSeconds: number }
export interface EnrollmentTokenDTO { token: string; expiresAt: string }
export interface ProjectDTO { id: string; name: string }
export interface WorkspacePlacementDTO {
  workerId: string
  status: 'pending' | 'provisioning' | 'ready' | 'failed' | 'deleting' | 'deleted'
  failureReason: string | null
  location: { rootPath: string } | null
}
export interface WorkspaceDTO {
  id: string
  projectId: string
  name: string
  repository?: { kind: 'blank' } | { kind: 'git'; url: string; revision?: string }
  placements: WorkspacePlacementDTO[]
  /** Compatibility projection of the primary placement for existing views. */
  workerId: string
  status: WorkspacePlacementDTO['status']
  failureReason: string | null
  location: { rootPath: string } | null
}
export type CommandStatus = 'pending' | 'accepted' | 'rejected' | 'completed' | 'failed' | 'cancelled'
export interface CommandDTO {
  commandId: string
  workerId: string
  status: CommandStatus
  createdAt: string
  updatedAt: string
}
export type RuntimeState = 'idle' | 'queued' | 'running' | 'stopping' | 'unavailable' | 'failed'
export interface FreshnessDTO {
  status: 'unknown' | 'syncing' | 'synced' | 'gap' | 'offline' | 'orphaned'
  throughSeq?: number
  cachedThroughSeq?: number
  contiguousSeq?: number
  workerLastSeq?: number | null
}
export interface SessionDTO {
  sendCapability?: import('@wemux/web-contract/task-platform').ActionCapability
  id: string
  projectId?: string
  title: string
  workspaceId: string
  workerId: string
  agentKey: string
  modelId: string | null
  runtimeState: RuntimeState
  archivedAt: string | null
  activeTurnId: string | null
  queuedMessageCount: number | null
  freshness: FreshnessDTO
  updatedAt: string
  canRead: boolean
  canSend: boolean
  canManage: boolean
}
export interface RuntimeUsageDTO {
  scope?: 'message' | 'operation' | 'native-session'
  subjectId?: string
  source?: 'runtime'
  revision?: number
  completeness?: 'complete' | 'partial'
  modelId?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
  costUsd?: number
  currency?: 'USD'
}
export type EventPayloadDTO =
  | { kind: 'message.queued'; commandId: string; messageId: string; content: string; position: number }
  | { kind: 'message.cancelled'; commandId: string; messageId: string }
  | { kind: 'message.rejected'; commandId: string; messageId: string; reason: string }
  | { kind: 'turn.started'; turnId: string; messageId: string }
  | { kind: 'assistant.text.delta'; turnId: string; text: string }
  | { kind: 'turn.finished'; turnId: string; outcome: 'completed' | 'cancelled' | 'failed'; failure: { code: string; message: string } | null }
  | { kind: 'session.runtime.changed'; state: RuntimeState; reason: string | null }
  | { kind: 'tool.started'; turnId: string; toolCallId: string; toolName: string; input: unknown }
  | { kind: 'tool.output.delta'; turnId: string; toolCallId: string; text: string }
  | { kind: 'tool.finished'; turnId: string; toolCallId: string; exitCode: number | null }
  | { kind: 'approval.requested'; turnId: string; approvalId: string; action: unknown; reason?: string }
  | { kind: 'approval.resolved'; turnId: string; approvalId: string; decision: 'approve' | 'deny' }
  | { kind: 'usage.updated'; turnId: string; usage: RuntimeUsageDTO }
  | { kind: 'compaction.started'; turnId: string; reason?: string }
  | { kind: 'compaction.finished'; turnId: string; summary?: string }
export interface JournalEventDTO { sessionId: string; seq: number; occurredAt: string; payload: EventPayloadDTO }
export interface EventsPageDTO { events: JournalEventDTO[]; throughSeq: number; hasMore: boolean }
export interface BootstrapResultDTO { user: { id: string }; team: { id: string; name: string }; project: ProjectDTO }
export interface SessionResourceDTO {
  sendCapability?: import('@wemux/web-contract/task-platform').ActionCapability
  id: string; projectId: string; workspaceId: string; title: string; runtimeState: RuntimeState; archivedAt?: string | null
  binding: { agent: { workerId: string; agentKey: string }; modelId: string | null }
}
export interface ServerEventsPageDTO { events: JournalEventDTO[]; nextSeq: number | null; freshness: FreshnessDTO }
export interface CreateProjectDTO { teamId: string; name: string; shareScope: 'owner-only' }
export type CreateWorkspaceDTO =
  | { workerId: string; name: string; source: 'empty' }
  | { workerId: string; name: string; source: 'git'; repository: { name: string; gitUrl: string; revision: string } }
export interface CreateSessionDTO { requestId: string; workspaceId: string; workerId: string; title: string; agentKey: string; modelId: string | null; shareScope: 'owner-only' }
export interface RuntimeCommandDTO { commandId: string; operationId: string; name: 'compact' | 'set_model' | 'set_thinking_level'; arguments?: Record<string, unknown> }
export interface ApprovalDecisionDTO { commandId: string; decision: 'approve' | 'deny' }
export interface PatchSessionDTO { title?: string; archived?: boolean }
export interface CommandResultDTO { commandId: string }
export interface SendMessageDTO { commandId: string; messageId: string; content: string }
export interface SendResultDTO { commandId: string; messageId: string; status: 'pending' | 'accepted' | 'queued' | 'rejected' | 'completed' | 'failed' }
export interface TailnetInfoDTO { available: boolean; state: string; dnsName: string | null; selfIps: string[]; lanIps: string[]; error?: string }
