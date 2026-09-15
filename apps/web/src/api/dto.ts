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
export interface WorkspaceDTO {
  id: string
  projectId: string
  workerId: string
  name: string
  status: 'pending' | 'provisioning' | 'ready' | 'failed' | 'deleting' | 'deleted'
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
  modelId: string
  runtimeState: RuntimeState
  activeTurnId: string | null
  queuedMessageCount: number | null
  freshness: FreshnessDTO
  updatedAt: string
  canRead: boolean
  canSend: boolean
  canManage: boolean
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
export interface JournalEventDTO { sessionId: string; seq: number; occurredAt: string; payload: EventPayloadDTO }
export interface EventsPageDTO { events: JournalEventDTO[]; throughSeq: number; hasMore: boolean }
export interface BootstrapResultDTO { user: { id: string }; team: { id: string; name: string }; project: ProjectDTO }
export interface SessionResourceDTO {
  sendCapability?: import('@wemux/web-contract/task-platform').ActionCapability
  id: string; projectId: string; workspaceId: string; title: string; runtimeState: RuntimeState
  binding: { agent: { workerId: string; agentKey: string }; modelId: string }
}
export interface ServerEventsPageDTO { events: JournalEventDTO[]; nextSeq: number | null; freshness: FreshnessDTO }
export interface CreateProjectDTO { teamId: string; name: string; shareScope: 'owner-only' }
export type CreateWorkspaceDTO =
  | { workerId: string; name: string; source: 'empty' }
  | { workerId: string; name: string; source: 'git'; repository: { name: string; gitUrl: string; revision: string } }
export interface CreateSessionDTO { workspaceId: string; title: string; agentKey: string; modelId: string; shareScope: 'owner-only' }
export interface SendMessageDTO { commandId: string; messageId: string; content: string }
export interface SendResultDTO { commandId: string; messageId: string; status: 'pending' | 'accepted' | 'queued' | 'rejected' | 'completed' | 'failed' }
export interface TailnetInfoDTO { available: boolean; state: string; dnsName: string | null; selfIps: string[]; lanIps: string[]; error?: string }
