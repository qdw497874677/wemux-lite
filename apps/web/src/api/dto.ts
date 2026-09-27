// Web-owned HTTP contract. Adapt backend differences here and in client.ts only.
export interface AgentDTO {
  agentKey: string
  displayName: string
  version: string | null
  mode: 'detect-only' | 'execution'
  availability: { status: 'available' | 'unavailable' | 'authentication-required'; reason?: string }
  agentCommands?: string[]
  compactMode?: 'native' | 'slash-command'
  modelSwap?: boolean
  models: { modelId: string; displayName: string; source: 'detected' | 'configured' }[]
}
export interface WorkerDTO {
  id: string
  teamId: string
  ownerId: string
  name: string
  shareScope: 'owner-only' | 'selected-members' | 'team'
  accessRole: 'owner' | 'use' | 'manage'
  connectionState: 'online' | 'offline' | 'revoked'
  version: string | null
  platform: string | null
  capabilities: AgentDTO[]
  lastSeenAt: string | null
}
export interface CreateEnrollmentTokenDTO { ttlSeconds: number }
export interface EnrollmentTokenDTO { token: string; expiresAt: string }
export interface ProjectDTO { id: string; teamId: string; ownerId: string; name: string; shareScope: 'owner-only' | 'selected-members' | 'team'; accessRole: 'owner' | 'viewer' | 'contributor' | 'manager' }
export interface WorkspacePlacementDTO {
  workerId: string
  status: 'ready' | 'stopped' | 'deleted' | 'failed' | 'unhealthy'
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
export interface FileEntryDTO { name: string; type: 'file' | 'directory'; size: number; mtime: string }
export interface FileListDTO { operation: 'list'; entries: FileEntryDTO[] }
export interface FileReadDTO { operation: 'read'; content: string | null; base64Content?: string; size: number; truncated: boolean; binary: boolean }
export interface FileWriteDTO { operation: 'write'; subpath: string; size: number }
export interface DiffLineDTO { type: 'add' | 'del' | 'ctx'; oldLine?: number; newLine?: number; text: string }
export interface FileDiffDTO { operation: 'diff'; supported: boolean; reason?: 'not-git'; lines: DiffLineDTO[] }
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
  access?: { canRead: boolean; canWrite: boolean; canControl: boolean; projectRole: 'owner' | 'manager' | 'contributor' | 'viewer' | null }
  shareScope?: 'owner-only' | 'selected-members' | 'project'
  id: string
  projectId?: string
  ownerId?: string
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
  customMetadata?: { wemux?: { usage?: { usedTokens?: number; totalTokens?: number; maxTokens?: number; contextWindow?: number; compactThreshold?: number } } }
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
export type AgentStreamKindDTO = 'assistant_text' | 'reasoning_text' | 'plan_text' | 'command_output' | 'file_change_output'
export type AbortReasonDTO = 'user_stop' | 'executor_disconnected' | 'control_plane_disconnect' | 'timeout' | 'provider_error' | 'cancelled' | 'unknown'
export type AgentFailureReasonDTO = 'agent_error.context_overflow' | 'agent_error.missing_config' | 'agent_error.provider_auth_or_access' | 'agent_error.provider_quota_limit' | 'agent_error.provider_capacity_or_rate_limit' | 'agent_error.provider_server_error' | 'agent_error.provider_network' | 'agent_error.model_not_found_or_unavailable' | 'agent_error.empty_or_unparseable_output' | 'agent_error.agent_timeout' | 'agent_error.runtime_missing_executable' | 'agent_error.runtime_version_unsupported' | 'agent_error.process_failure' | 'agent_error.unknown'
export type TurnFailureDTO = { code: 'interrupted' | 'agent-unavailable' | 'agent-error' | 'internal-error'; message: string; abortReason?: AbortReasonDTO; failureReason?: AgentFailureReasonDTO; retryable?: boolean }
export type EventPayloadDTO =
  | { kind: 'message.queued'; commandId: string; messageId: string; content: string; position: number }
  | { kind: 'message.cancelled'; commandId: string; messageId: string }
  | { kind: 'message.rejected'; commandId: string; messageId: string; reason: string }
  | { kind: 'turn.started'; turnId: string; messageId: string }
  | { kind: 'assistant.text.delta'; turnId: string; text: string; streamKind?: Extract<AgentStreamKindDTO, 'assistant_text' | 'reasoning_text' | 'plan_text'> }
  | { kind: 'turn.finished'; turnId: string; outcome: 'completed' | 'cancelled' | 'failed'; failure: TurnFailureDTO | null }
  | { kind: 'session.runtime.changed'; state: RuntimeState; reason: string | null }
  | { kind: 'tool.started'; turnId: string; toolCallId: string; toolName: string; input: unknown; streamKind?: Extract<AgentStreamKindDTO, 'command_output' | 'file_change_output'> }
  | { kind: 'tool.output.delta'; turnId: string; toolCallId: string; text: string; streamKind?: Extract<AgentStreamKindDTO, 'command_output' | 'file_change_output'> }
  | { kind: 'tool.finished'; turnId: string; toolCallId: string; exitCode: number | null }
  | { kind: 'approval.requested'; turnId: string; approvalId: string; action: unknown; reason?: string }
  | { kind: 'approval.resolved'; turnId: string; approvalId: string; decision: 'approve' | 'deny' }
  | { kind: 'usage.updated'; turnId: string; usage: RuntimeUsageDTO }
  | { kind: 'compaction.started'; turnId: string; reason?: string }
  | { kind: 'compaction.finished'; turnId: string; summary?: string }
  | { kind: 'model.changed'; previousModelId: string | null; modelId: string }
  | { kind: 'runtime.notice'; level: 'info' | 'warning'; code: string; message: string; retry?: { attempt: number; maxAttempts: number | null; delayMs: number | null } }
export interface JournalEventDTO { sessionId: string; seq: number; occurredAt: string; payload: EventPayloadDTO }
export interface EventsPageDTO { events: JournalEventDTO[]; throughSeq: number; hasMore: boolean }
/**
 * 浏览器账号契约（Ticket 04）。登录会话只经 HttpOnly Cookie 承载，任何响应都不返回可当 Bearer 使用的令牌。
 */
export type AccountStatusDTO = 'active' | 'disabled' | 'deletion_pending' | 'deleted'
export interface AccountUserDTO { id: string; username: string; email: string | null; createdAt: string; status?: AccountStatusDTO; authVersion?: number; statusChangedAt?: string | null; deletedAt?: string | null }
export interface LoginSessionDTO {
  id: string; current: boolean; authenticationMethod: string; client: string | null
  authenticatedAt: string; createdAt: string; lastSeenAt: string
  idleExpiresAt: string; absoluteExpiresAt: string; revokedAt: string | null
}
export type PersonalAccessTokenScopeDTO = 'read' | 'write' | 'execute' | 'admin'
export interface PersonalAccessTokenDTO {
  id: string; name: string; scopes: PersonalAccessTokenScopeDTO[]
  createdAt: string; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null
}
export interface IssuedPersonalAccessTokenDTO extends PersonalAccessTokenDTO { token: string }
export type RegistrationPolicyDTO = 'open' | 'invite_only' | 'closed'
/** 注册与邮件能力：`emailDelivery` 为 false 时前端必须如实告知，不得模拟“邮件已发送”。 */
export interface RegistrationCapabilitiesDTO {
  registrationPolicy: RegistrationPolicyDTO
  emailDelivery: boolean
  emailDeliveryReason: string | null
  passwordMinimumLength: number
  passwordMaximumLength: number
  verificationTtlMs: number
  resetTtlMs: number
}
export interface GoogleCapabilityDTO { enabled: boolean; reason: string | null }
/** 公开安全配置：只回答“声明了没有 / 声明邮箱建号了没有”，不泄露邮箱名单。 */
export interface AuthOptionsDTO { administratorConfigured: boolean; administratorRegistered: boolean; passwordMinimumLength: number; registration: RegistrationCapabilitiesDTO | null; google: GoogleCapabilityDTO }
/** 注册、重发验证、找回密码：响应形状统一，不泄露邮箱是否已注册。 */
export interface AcceptedEmailDTO { status: 'accepted'; email: string }
export interface RegistrationPolicyViewDTO { policy: RegistrationPolicyDTO; explicit: boolean; updatedAt: string | null; updatedBy: string | null }
export interface PasswordResetDTO { status: 'reset'; revokedSessions: number; revokedTokens: number }
/** 验证成功的响应既是一次登录（向浏览器写入 Cookie 会话），也是账号视图。 */
export type VerifiedEmailDTO = AccountPayloadDTO & { status: 'verified' }
/** 初始化与登录响应：明文 CSRF 令牌只在这里出现一次，客户端需常驻内存并随写请求回传。 */
export interface AccountPayloadDTO { user: AccountUserDTO; teamId: string | null; session: LoginSessionDTO; expiresAt: string; csrfToken: string; instanceAdministrator: boolean }
/** `GET /api/auth/me`：仅在令牌轮换时附带新的明文 CSRF 令牌。 */
export interface AccountViewDTO { user: AccountUserDTO; teamId: string | null; session: LoginSessionDTO; csrfToken?: string; csrfTokenRotated?: boolean; instanceAdministrator: boolean }
export interface SessionResourceDTO {
  sendCapability?: import('@wemux/web-contract/task-platform').ActionCapability
  access?: { canRead: boolean; canWrite: boolean; canControl: boolean; projectRole: 'owner' | 'manager' | 'contributor' | 'viewer' | null }
  shareScope?: 'owner-only' | 'selected-members' | 'project'
  id: string; projectId: string; ownerId: string; workspaceId: string; title: string; runtimeState: RuntimeState; archivedAt?: string | null
  binding: { agent: { workerId: string; agentKey: string }; modelId: string | null }
}
export interface ServerEventsPageDTO { events: JournalEventDTO[]; nextSeq: number | null; freshness: FreshnessDTO }
export interface CreateProjectDTO { teamId: string; name: string; shareScope: 'owner-only' | 'selected-members' | 'team' }
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

/**
 * 账号安全（Ticket 06/08）：登录方式、密码状态与邮件能力。
 * 响应里没有令牌、哈希，也没有“待确认的新邮箱”——那个地址只存在于邮件里。
 */
export interface LoginMethodDTO {
  kind: 'password' | 'google'
  id: string
  label: string
  email: string | null
  createdAt: string | null
  lastSignInAt: string | null
  /** 唯一的登录方式不可移除：解绑后账号将无法登录，服务端也会拒绝。 */
  removable: boolean
}
export interface AccountSecurityViewDTO {
  methods: LoginMethodDTO[]
  passwordSet: boolean
  email: string | null
  emailDelivery: boolean
  emailDeliveryReason: string | null
  /** 当前会话是否在强认证窗口内（刚登录或刚用 Google 授权过）。 */
  reauthenticated: boolean
  reauthenticateWindowMs: number
}
export interface PasswordChangeDTO { status: 'changed'; created: boolean; revokedSessions: number; revokedTokens: number }
export interface EmailChangeAcceptedDTO { status: 'accepted'; email: string; expiresAt: string }
export interface EmailChangeConfirmedDTO { status: 'changed'; email: string; previousEmail: string | null }
export interface GoogleLinkStartDTO { authorizeUrl: string; expiresAt: string }
export interface LoginMethodUnboundDTO { status: 'unbound'; kind: LoginMethodDTO['kind']; methods: LoginMethodDTO[] }
export interface AccountLifecycleDTO { status: AccountStatusDTO; statusChangedAt: string | null; blockers: string[] }
export interface ManagedAccountDTO { id: string; username: string; email: string | null; status: AccountStatusDTO; statusChangedAt: string | null }
export interface AuditEntryDTO {
  id: string; actorId: string | null; action: string; result: 'succeeded' | 'failed'; occurredAt: string
  resource: { kind: 'team' | 'worker' | 'project' | 'workspace' | 'session' | 'user'; id: string }
  metadata: Record<string, string | number | boolean | null>
}
export interface AuditPageDTO { items: AuditEntryDTO[]; nextCursor: string | null }
export interface AuditQueryDTO { actorId?: string; action?: string; resourceKind?: AuditEntryDTO['resource']['kind']; resourceId?: string; result?: AuditEntryDTO['result']; from?: string; to?: string; cursor?: string; limit?: number }
