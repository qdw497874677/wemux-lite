export type HostKind = 'cluster' | 'local-worker'
export type HostBootstrap = {
  hostKind: HostKind
  contractVersion: number
  capabilities: readonly string[]
}

/** Cluster identity projection, not a bearer credential. Never used for local Worker authentication. */
export interface AccountSession { teamId: string; csrfToken: string; username: string; email: string | null; instanceAdministrator: boolean }

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

export type ReviewPolicy = 'none' | 'agent' | 'human' | 'multi-stage'
export interface ProjectDTO { id: string; teamId: string; ownerId: string; name: string; shareScope: 'owner-only' | 'selected-members' | 'team'; reviewPolicy?: ReviewPolicy; reviewPolicyVersion?: number; accessRole: 'owner' | 'viewer' | 'contributor' | 'manager' }

export type AccountStatusDTO = 'active' | 'disabled' | 'deletion_pending' | 'deleted'

export interface AccountUserDTO { id: string; username: string; email: string | null; createdAt: string; status?: AccountStatusDTO; authVersion?: number; statusChangedAt?: string | null; deletedAt?: string | null }

export interface LoginSessionDTO {
  id: string; current: boolean; authenticationMethod: string; client: string | null
  authenticatedAt: string; createdAt: string; lastSeenAt: string
  idleExpiresAt: string; absoluteExpiresAt: string; revokedAt: string | null
}

export type RegistrationPolicyDTO = 'open' | 'invite_only' | 'closed'
/** Team 协调入口可用性投影（票 05）：状态与禁用原因唯一来自服务端资格门。 */
export type TeamCoordinationAvailabilityDTO = { status: 'disabled' | 'enabled'; gate: { verdict: 'FAIL' | 'PASS'; reasons: readonly string[]; evidencePath: string; remediationSection: string; reopenConditions: readonly string[] } }

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

export interface AuthOptionsDTO { administratorConfigured: boolean; administratorRegistered: boolean; passwordMinimumLength: number; registration: RegistrationCapabilitiesDTO | null; google: GoogleCapabilityDTO }

/** Login credentials stay in the HttpOnly Cookie; only the write-protection token is exposed. */
export interface AccountPayloadDTO { user: AccountUserDTO; teamId: string | null; session: LoginSessionDTO; expiresAt: string; csrfToken: string; instanceAdministrator: boolean }

/** GET /api/auth/me includes a CSRF token when it is rotated. */
export interface AccountViewDTO { user: AccountUserDTO; teamId: string | null; session: LoginSessionDTO; csrfToken?: string; csrfTokenRotated?: boolean; instanceAdministrator: boolean }

export interface LocalStatus {
  csrf: string
  capabilities: AgentDTO[]
  installation: { name: string; installationId: string }
  cluster: { enrolled: boolean; serverUrl?: string; workerId?: string; connection: { phase: string; failure: string | null } | null }
}

export type PersonalAccessTokenScopeDTO = 'read' | 'write' | 'execute' | 'admin'
export interface PersonalAccessTokenDTO {
  id: string; name: string; scopes: PersonalAccessTokenScopeDTO[]
  createdAt: string; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null
}
export interface IssuedPersonalAccessTokenDTO extends PersonalAccessTokenDTO { token: string }
export interface AcceptedEmailDTO { status: 'accepted'; email: string }
export interface RegistrationPolicyViewDTO { policy: RegistrationPolicyDTO; explicit: boolean; updatedAt: string | null; updatedBy: string | null }
export interface PasswordResetDTO { status: 'reset'; revokedSessions: number; revokedTokens: number }
/** 验证成功的响应既是一次登录（向浏览器写入 Cookie 会话），也是账号视图。 */
export type VerifiedEmailDTO = AccountPayloadDTO & { status: 'verified' }
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

/** Workspace is logical; each physical placement reports its own health and path. */
export interface WorkspaceDTO {
  /** Opaque persisted state fingerprint, not a monotonic version. */
  revision: string
  deletedAt?: string | null
  /** Personal visibility CAS version; present on list items, not necessarily on detail responses. */
  visibilityRevision?: number
  visibilityHidden?: boolean
  id: string; projectId: string; name: string
  spec: { kind: 'repository'; repositoryId: string } | { kind: 'composite'; memberWorkspaceIds: string[] }
  placements: { workerId: string; status: 'ready' | 'stopped' | 'deleted' | 'failed' | 'unhealthy'; failureReason: string | null; location: { rootPath: string } | null; provisioning?: { commandId: string; startedAt: string } }[]
}
export interface WorkerDTO {
  id: string; teamId: string; name: string; connectionState: 'online' | 'offline' | 'revoked'; capabilities: AgentDTO[]
}
