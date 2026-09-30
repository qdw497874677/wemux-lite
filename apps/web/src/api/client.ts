import type { NodeResourcePreset, NodeResourcePresetApplication, NodeResourcePresetEntry, Resource, ResourceBinding, ResourceBindingStatus, ResourceRevision, ReconcileReport, ResourceSetSnapshot } from '@wemux/domain'
import type { Run, LaunchRequest, LaunchResponse, TaskSummary, TaskDetail, TaskCreate, TaskPatch, TaskActivity, AssignmentRequest, CreateTaskWorkspaceRequest, UnbindWorkspaceRequest } from '@wemux/web-contract/task-platform'
import type { CanvasLayoutResponse, CanvasLayoutSaveRequest, CanvasLayoutSaveResponse, CanvasLayoutScope, SessionGraphResponse } from '@wemux/web-contract/session-graph'
import type { ConnectorDTO, ConnectorListDTO, ConnectorTestDTO, ConnectorWriteDTO } from '@wemux/web-contract/connectors'
import type { ChannelListDTO, CreateChannelBindingDTO, CreateChannelDTO, CreatedChannelDTO, DeleteChannelDTO, DeletedChannelDTO, RotateChannelTokenDTO } from '@wemux/web-contract/channels'
import { randomId } from '../lib/random.ts'
import { readDeviceId } from '../lib/device-scope.ts'
import type {
  ApprovalDecisionDTO, RuntimeCommandDTO, PatchSessionDTO, CommandResultDTO,
  AccountPayloadDTO, AccountViewDTO, AcceptedEmailDTO, AccountSecurityViewDTO, AuthOptionsDTO, CommandDTO, CreateEnrollmentTokenDTO, CreateProjectDTO,
  CreateSessionDTO, CreateWorkspaceDTO, EmailChangeAcceptedDTO, EmailChangeConfirmedDTO, EnrollmentTokenDTO, EventsPageDTO, GoogleLinkStartDTO, IssuedPersonalAccessTokenDTO, LoginMethodUnboundDTO, LoginSessionDTO, PasswordChangeDTO, PasswordResetDTO, PersonalAccessTokenDTO, PersonalAccessTokenScopeDTO, ProjectDTO,
  AccountLifecycleDTO, AuditPageDTO, AuditQueryDTO, ManagedAccountDTO, RegistrationPolicyDTO, RegistrationPolicyViewDTO, SendMessageDTO, SendResultDTO, SessionDTO, SessionResourceDTO, ServerEventsPageDTO, TailnetInfoDTO, VerifiedEmailDTO, WorkerDTO, WorkspaceDTO, FileDiffDTO, FileListDTO, FileReadDTO, FileWriteDTO,
} from './dto'

/**
 * 浏览器会话作用域：认证凭据（登录令牌）只在 HttpOnly Cookie 里，JS 无法也不应该读到它。
 * 这里只保存当前账号的可展示信息与写保护令牌（CSRF），刷新页面后由 `GET /api/auth/me` 重建。
 */
export interface AccountSession { teamId: string; csrfToken: string; username: string; email: string | null; instanceAdministrator: boolean }
export const anonymousSession = (): AccountSession => ({ teamId: '', csrfToken: '', username: '', email: null, instanceAdministrator: false })
export const isSignedIn = (session: AccountSession): boolean => session.username !== ''
const id = encodeURIComponent
export const routes = {
  authOptions: '/api/auth/options',
  authGoogleStart: '/api/auth/oauth/google/start',
  authLogin: '/api/auth/login',
  authMe: '/api/auth/me',
  authLogout: '/api/auth/logout',
  authLogoutAll: '/api/auth/logout-all',
  authRegister: '/api/auth/register',
  authRegisterResend: '/api/auth/register/resend',
  authVerifyEmail: '/api/auth/email/verify',
  authForgotPassword: '/api/auth/password/forgot',
  authResetPassword: '/api/auth/password/reset',
  // Ticket 06/08：账号安全面板用到的入口，全部需要 Cookie 会话与 CSRF 令牌。
  authPasswordChange: '/api/auth/password/change',
  authEmailChange: '/api/auth/email/change',
  authEmailChangeConfirm: '/api/auth/email/change/confirm',
  authGoogleLinkStart: '/api/auth/identities/google/start',
  authIdentity: (methodId: string) => `/api/auth/identities/${id(methodId)}`,
  accountSecurity: '/api/auth/account/security',
  accountLifecycle: '/api/auth/account/lifecycle',
  accountAudit: '/api/auth/account/audit',
  accountAuditExport: '/api/auth/account/audit/export',
  managedAccounts: '/api/auth/account/users',
  managedAccountAction: (userId: string, action: 'disable' | 'restore' | 'request-deletion' | 'confirm-deletion') => `/api/auth/account/users/${id(userId)}/${action}`,
  registrationPolicy: '/api/settings/registration-policy',
  loginSessions: '/api/auth/sessions',
  loginSession: (sessionId: string) => `/api/auth/sessions/${id(sessionId)}`,
  personalAccessTokens: '/api/auth/personal-access-tokens',
  personalAccessToken: (tokenId: string) => `/api/auth/personal-access-tokens/${id(tokenId)}`,
  rotatePersonalAccessToken: (tokenId: string) => `/api/auth/personal-access-tokens/${id(tokenId)}/rotate`,
  enrollmentTokens: '/api/enrollment-tokens',
  tailnet: '/api/cluster/tailnet',
  workers: '/api/workers',
  resources: '/api/resources',
  resource: (resourceId: string) => `/api/resources/${id(resourceId)}`,
  resourceRevisions: (resourceId: string) => `/api/resources/${id(resourceId)}/revisions`,
  resourceBlob: (sha256: string) => `/api/resource-blobs/${id(sha256)}`,
  resourceBindings: '/api/resource-bindings',
  resourcePresets: '/api/resource-presets',
  resourcePresetApplications: '/api/resource-preset-applications',
  resourcePresetApplicationsFor: (presetId: string) => `/api/resource-presets/${id(presetId)}/applications`,
  resourceSet: (workerId: string) => `/api/workers/${id(workerId)}/resource-set`,
  resourceBinding: (bindingId: string) => `/api/resource-bindings/${id(bindingId)}`,
  capabilities: (workerId: string) => `/api/workers/${id(workerId)}/capabilities`,
  workerAccess: (workerId: string) => `/api/workers/${id(workerId)}/access`,
  workerGrants: (workerId: string) => `/api/workers/${id(workerId)}/grants`,
  workerGrant: (workerId: string, userId: string) => `/api/workers/${id(workerId)}/grants/${id(userId)}`,
  revokeWorker: (workerId: string) => `/api/workers/${id(workerId)}/revoke`,
  teams: '/api/teams',
  teamMembers: (teamId: string) => `/api/teams/${id(teamId)}/members`,
  teamMember: (teamId: string, userId: string) => `/api/teams/${id(teamId)}/members/${id(userId)}`,
  teamOwnershipTransfer: (teamId: string) => `/api/teams/${id(teamId)}/ownership-transfer`,
  teamInvitations: (teamId: string) => `/api/teams/${id(teamId)}/invitations`,
  teamInvitation: (teamId: string, invitationId: string) => `/api/teams/${id(teamId)}/invitations/${id(invitationId)}`,
  invitation: (token: string) => `/api/team-invitations/${id(token)}`,
  acceptInvitation: (token: string) => `/api/team-invitations/${id(token)}/accept`,
  projects: '/api/projects',
  projectAccess: (projectId: string) => `/api/projects/${id(projectId)}/access`,
  projectGrants: (projectId: string) => `/api/projects/${id(projectId)}/grants`,
  projectGrant: (projectId: string, userId: string) => `/api/projects/${id(projectId)}/grants/${id(userId)}`,
  connectors: (projectId: string) => `/api/projects/${id(projectId)}/connectors`,
  connector: (projectId: string, connectorId: string) => `/api/projects/${id(projectId)}/connectors/${id(connectorId)}`,
  connectorState: (projectId: string, connectorId: string, action: 'enable' | 'disable' | 'test') => `/api/projects/${id(projectId)}/connectors/${id(connectorId)}/${action}`,
  channels: (projectId: string) => `/api/projects/${id(projectId)}/channels`,
  channelState: (projectId: string, channelId: string) => `/api/projects/${id(projectId)}/channels/${id(channelId)}/enabled`,
  channel: (projectId: string, channelId: string) => `/api/projects/${id(projectId)}/channels/${id(channelId)}`,
  channelTest: (projectId: string, channelId: string) => `/api/projects/${id(projectId)}/channels/${id(channelId)}/test`,
  channelTokenRotation: (projectId: string, channelId: string) => `/api/projects/${id(projectId)}/channels/${id(channelId)}/token/rotate`,
  channelBindings: (projectId: string) => `/api/projects/${id(projectId)}/channel-bindings`,
  channelBindingState: (projectId: string, bindingId: string) => `/api/projects/${id(projectId)}/channel-bindings/${id(bindingId)}/enabled`,
  channelReplay: (projectId: string, deliveryId: string) => `/api/projects/${id(projectId)}/channel-deliveries/${id(deliveryId)}/replay`,
  workspaces: '/api/workspaces',
  workspacePlacements: (workspaceId: string) => `/api/workspaces/${id(workspaceId)}/placements`,
  reprovisionWorkspace: (workspaceId: string) => `/api/workspaces/${id(workspaceId)}/reprovision`,
  sessions: '/api/sessions',
  createSession: '/api/sessions',
  session: (sessionId: string) => `/api/sessions/${id(sessionId)}`,
  sessionAccess: (sessionId: string) => `/api/sessions/${id(sessionId)}/access`,
  sessionGrants: (sessionId: string) => `/api/sessions/${id(sessionId)}/grants`,
  sessionGrant: (sessionId: string, userId: string) => `/api/sessions/${id(sessionId)}/grants/${id(userId)}`,
  sessionGraph: (projectId: string) => `/api/projects/${id(projectId)}/session-graph`,
  canvasLayout: (projectId: string) => `/api/projects/${id(projectId)}/canvas-layout`,
  deleteSession: (sessionId: string) => `/api/sessions/${id(sessionId)}`,
  messages: (sessionId: string) => `/api/sessions/${id(sessionId)}/messages`,
  stopTurn: (sessionId: string) => `/api/sessions/${id(sessionId)}/turn/stop`,
  cancelQueued: (sessionId: string, submissionCommandId: string) => `/api/sessions/${id(sessionId)}/messages/${id(submissionCommandId)}/cancel`,
  runtimeCommands: (sessionId: string) => `/api/sessions/${id(sessionId)}/runtime/commands`,
  runtimeApproval: (sessionId: string, approvalId: string) => `/api/sessions/${id(sessionId)}/runtime/approvals/${id(approvalId)}`,
  sessionFilesList: (sessionId: string) => `/api/sessions/${id(sessionId)}/fs/list`,
  sessionFilesRead: (sessionId: string) => `/api/sessions/${id(sessionId)}/fs/read`,
  sessionFilesWrite: (sessionId: string) => `/api/sessions/${id(sessionId)}/fs/write`,
  sessionFilesDiff: (sessionId: string) => `/api/sessions/${id(sessionId)}/fs/diff`,
  sessionTerminal: (sessionId: string) => `/api/sessions/${id(sessionId)}/terminal`,
  sessionTerminalAction: (sessionId: string, terminalId: string, action: 'write' | 'resize' | 'dispose') => `/api/sessions/${id(sessionId)}/terminal/${id(terminalId)}/${action}`,
  sessionTerminalStream: (sessionId: string) => `/api/sessions/${id(sessionId)}/terminal/stream`,
  commands: '/api/commands',
  command: (commandId: string) => `/api/commands/${id(commandId)}`,
  events: (sessionId: string) => `/api/sessions/${id(sessionId)}/events`,
  stream: (sessionId: string) => `/api/sessions/${id(sessionId)}/stream`,
}

export class ApiError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) { super(message); this.status = status }
}

export function createApi(config: AccountSession, onUnauthorized: () => void = () => {}) {
  const scope = new AbortController()
  // CSRF 明文只驻留内存；服务端在轮换后通过 `GET /api/auth/me` 重新下发。
  let csrfToken = config.csrfToken
  const unsafe = (method: string) => method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
  const unauthorized = () => { if (!scope.signal.aborted) { scope.abort(); onUnauthorized() } }
  const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
  async function send(path: string, body: unknown, signal: AbortSignal | undefined, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT' | undefined, timeoutMs: number, extra?: Record<string, string>): Promise<Response> {
    const resolved = method ?? (body === undefined ? 'GET' : 'POST')
    const headers: Record<string, string> = { Accept: 'application/json', ...extra }
    // 登录凭据只走 Cookie；写请求额外带 CSRF 令牌，服务端据此判定请求来自本页。
    if (csrfToken && unsafe(resolved)) headers['X-CSRF-Token'] = csrfToken
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const url = new URL(path, window.location.origin)
    if (config.teamId) url.searchParams.set('teamId', config.teamId)
    try {
      return await fetch(url, {
        method: resolved, headers, credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([scope.signal, ...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new ApiError('连接失败：无法访问 Server，请检查服务是否启动、端口与网络。')
    }
  }
  /** 同一账号的其他标签页可能轮换过 CSRF 令牌；写失败时取回新令牌重试一次，避免假失败。 */
  async function refreshCsrf(): Promise<boolean> {
    try {
      const response = await send(routes.authMe, undefined, undefined, 'GET', 15000)
      if (!response.ok) return false
      const account = await response.json() as { csrfToken?: string }
      if (!account.csrfToken) return false
      csrfToken = account.csrfToken
      return true
    } catch { return false }
  }
  async function request<T>(path: string, body?: unknown, signal?: AbortSignal, method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', timeoutMs = 15000, extra?: Record<string, string>): Promise<T> {
    if (scope.signal.aborted) throw new DOMException("Connection disposed", "AbortError")
    let response = await send(path, body, signal, method, timeoutMs, extra)
    if (response.status === 403 && csrfToken && await refreshCsrf()) response = await send(path, body, signal, method, timeoutMs, extra)
    if (scope.signal.aborted) throw new DOMException("Connection disposed", "AbortError")
    if (response.status === 401) unauthorized()
    if (!response.ok) {
      let detail = ''
      try {
        const payload = await response.clone().json() as { error?: { message?: string }; message?: string }
        detail = payload.error?.message ?? payload.message ?? ''
      } catch { /* Keep the status-based fallback for non-JSON error bodies. */ }
      const hint = response.status === 401
        ? '登录会话已失效，请重新登录。'
        : response.status === 403 ? detail || '登录会话缺少有效的写保护令牌，请刷新页面后重试。'
          : detail || '请稍后重试；如持续失败，请检查 Server 日志。'
      throw new ApiError(`请求失败（HTTP ${response.status}）：${hint}`, response.status)
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as T
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new ApiError('服务端响应格式异常，请检查当前访问地址是否为 Wemux Lite Server。')
    }
    return response.json() as Promise<T>
  }
  async function list<T>(path: string, signal?: AbortSignal): Promise<T[]> {
    const value = await request<{ items: T[] }>(path, undefined, signal)
    if (!Array.isArray(value.items)) throw new ApiError('API 契约错误：列表响应应包含 items 数组。')
    return value.items
  }
  return {
    launchScope: JSON.stringify([window.location.origin, readDeviceId(), config.teamId]),
    attention: (signal?: AbortSignal) => request<import('@wemux/server-domain').AttentionResult>('/api/attention', undefined, signal),
    artifacts: (projectId: string, taskId: string, signal?: AbortSignal) => request<{ items: readonly import('@wemux/server-domain').Artifact[] }>(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/artifacts`, undefined, signal),
    taskRunsForArtifacts: (projectId: string, taskId: string, signal?: AbortSignal) => request<{ items: readonly { id: string; status: string }[] }>(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/runs`, undefined, signal),
    registerArtifact: (projectId: string, taskId: string, input: Omit<import('@wemux/server-domain').RegisterArtifactCommand, 'taskId'>) => request<import('@wemux/server-domain').Artifact>(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/artifacts`, { method: 'POST', body: JSON.stringify(input) }),
    reviewArtifact: (artifactId: string, input: Omit<import('@wemux/server-domain').ReviewArtifactCommand, 'artifactId'>) => request<import('@wemux/server-domain').Artifact>(`/api/artifacts/${encodeURIComponent(artifactId)}/review`, { method: 'POST', body: JSON.stringify(input) }),
    sessionGraph: (projectId: string, signal?: AbortSignal) => request<SessionGraphResponse>(routes.sessionGraph(projectId), undefined, signal),
    canvasLayout: (projectId: string, scope: CanvasLayoutScope, signal?: AbortSignal) => request<CanvasLayoutResponse>(`${routes.canvasLayout(projectId)}?scope=${scope}`, undefined, signal),
    saveCanvasLayout: (projectId: string, body: CanvasLayoutSaveRequest) => request<CanvasLayoutSaveResponse>(routes.canvasLayout(projectId), body, undefined, 'PUT'),
    canvasCollaboration: (projectId: string, signal?: AbortSignal) => request<{ projectId: string; revision: number; presence: Array<{ userId: string; displayName: string; activeSessionId: string | null; typing: boolean; expiresAt: string }> }>(`/api/projects/${id(projectId)}/canvas/collaboration`, undefined, signal),
    updateCanvasPresence: (projectId: string, body: { displayName: string; activeSessionId: string | null; typing: boolean }) => request<{ projectId: string; revision: number; presence: Array<{ userId: string; displayName: string; activeSessionId: string | null; typing: boolean; expiresAt: string }> }>(`/api/projects/${id(projectId)}/canvas/collaboration/presence`, body, undefined, 'PUT'),
    pendingReviews: (p: string, signal?: AbortSignal) => list<import('@wemux/web-contract/task-platform').ReviewRequest>(`/api/projects/${id(p)}/reviews`, signal),
    projectActivity: (p: string, after = 0, signal?: AbortSignal) => list<import('@wemux/web-contract/task-platform').ProjectActivityItem>(`/api/projects/${id(p)}/activity?after=${after}`, signal),
    review: (p: string, t: string, runId: string, signal?: AbortSignal) => request<{ review: import('@wemux/web-contract/task-platform').ReviewRequest | null }>(`/api/projects/${id(p)}/tasks/${id(t)}/runs/${id(runId)}/review`, undefined, signal),
    reviewAction: (p: string, t: string, runId: string, body: import('@wemux/web-contract/task-platform').ReviewActionRequest) => request<{ review: import('@wemux/web-contract/task-platform').ReviewRequest; task: TaskDetail }>(`/api/projects/${id(p)}/tasks/${id(t)}/runs/${id(runId)}/review`, body),
    runs: (p: string, t: string, signal?: AbortSignal) => list<Run>(`/api/projects/${id(p)}/tasks/${id(t)}/runs`, signal),
    createTaskSession: (p: string, t: string, title: string) => request<{ session: { id: string } }>(`/api/projects/${id(p)}/tasks/${id(t)}/sessions`, { title }),
    cancelRun: (p: string, t: string, body: { runId: string; sessionId: string; requestId: string }) => request<{ run: Run }>(`/api/projects/${id(p)}/tasks/${id(t)}/runs/${id(body.runId)}/cancel`, body),
    launch: (p: string, t: string, body: LaunchRequest) => request<LaunchResponse>(`/api/projects/${id(p)}/tasks/${id(t)}/launch`, body),
    assignTask: (p: string, t: string, body: AssignmentRequest) => request<TaskDetail>(`/api/projects/${id(p)}/tasks/${id(t)}/assignment`, body, undefined, 'PUT'),
    clearTaskAssignment: (p: string, t: string, version: number) => request<TaskDetail>(`/api/projects/${id(p)}/tasks/${id(t)}/assignment`, { version }, undefined, 'DELETE'),
    bindTaskWorkspace: (p: string, t: string, w: string) => request<TaskDetail>(`/api/projects/${id(p)}/tasks/${id(t)}/workspaces/${id(w)}`, {}, undefined, 'PUT'),
    unbindTaskWorkspace: (p: string, t: string, w: string, body: UnbindWorkspaceRequest) => request<TaskDetail>(`/api/projects/${id(p)}/tasks/${id(t)}/workspaces/${id(w)}`, body, undefined, 'DELETE'),
    createTaskWorkspace: (p: string, t: string, body: CreateTaskWorkspaceRequest) => request<{ task: TaskDetail; workspace: WorkspaceDTO; commandId: string }>(`/api/projects/${id(p)}/tasks/${id(t)}/workspaces`, body),
    retryTaskWorkspace: (p: string, t: string, w: string, requestId: string) => request<{ task: TaskDetail; workspace: WorkspaceDTO; commandId: string }>(`/api/projects/${id(p)}/tasks/${id(t)}/workspaces/${id(w)}/retry`, { requestId }),
    tasks: (projectId: string, signal?: AbortSignal) => list<TaskSummary>(`/api/projects/${id(projectId)}/tasks`, signal),
    task: (projectId: string, taskId: string, signal?: AbortSignal) => request<TaskDetail>(`/api/projects/${id(projectId)}/tasks/${id(taskId)}`, undefined, signal),
    createTask: (projectId: string, body: TaskCreate) => request<TaskDetail>(`/api/projects/${id(projectId)}/tasks`, body),
    patchTask: (projectId: string, taskId: string, body: TaskPatch) => request<TaskDetail>(`/api/projects/${id(projectId)}/tasks/${id(taskId)}`, body, undefined, 'PATCH'),
    taskActivity: (projectId: string, taskId: string, signal?: AbortSignal) => list<TaskActivity>(`/api/projects/${id(projectId)}/tasks/${id(taskId)}/activity`, signal),
    addTaskLink: (projectId: string, taskId: string, url: string) => request<TaskDetail>(`/api/projects/${id(projectId)}/tasks/${id(taskId)}/links`, { url }),
    removeTaskLink: (projectId: string, taskId: string, linkId: string) => request<TaskDetail>(`/api/projects/${id(projectId)}/tasks/${id(taskId)}/links/${id(linkId)}`, undefined, undefined, 'DELETE'),
    dispose: () => scope.abort(),
    // 账号与会话（Ticket 04）：凭据只经 HttpOnly Cookie，响应里没有可当 Bearer 用的令牌。
    // 不再有“首次认领”入口：授权根是服务端启动配置的 WEMUX_ADMIN_EMAILS。
    authOptions: (signal?: AbortSignal) => request<AuthOptionsDTO>(routes.authOptions, undefined, signal),
    login: async (login: string, password: string) => {
      const account = await request<AccountPayloadDTO>(routes.authLogin, { login, password })
      csrfToken = account.csrfToken
      return account
    },
    // Google 登录（Ticket 07）：拿到授权地址后由调用方整页跳转，会话仍由回调写入 HttpOnly Cookie。
    startGoogleSignIn: (returnTo?: string) => request<{ authorizeUrl: string; expiresAt: string }>(routes.authGoogleStart, returnTo ? { returnTo } : {}),
    currentAccount: async (signal?: AbortSignal) => {
      const account = await request<AccountViewDTO>(routes.authMe, undefined, signal)
      if (account.csrfToken) csrfToken = account.csrfToken
      return account
    },
    loginSessions: (signal?: AbortSignal) => list<LoginSessionDTO>(routes.loginSessions, signal),
    revokeLoginSession: (sessionId: string) => request<void>(routes.loginSession(sessionId), undefined, undefined, 'DELETE'),
    personalAccessTokens: (signal?: AbortSignal) => list<PersonalAccessTokenDTO>(routes.personalAccessTokens, signal),
    createPersonalAccessToken: (body: { name: string; scopes: PersonalAccessTokenScopeDTO[]; expiresAt: string }) => request<IssuedPersonalAccessTokenDTO>(routes.personalAccessTokens, body),
    revokePersonalAccessToken: (tokenId: string) => request<void>(routes.personalAccessToken(tokenId), undefined, undefined, 'DELETE'),
    rotatePersonalAccessToken: (tokenId: string, expiresAt: string) => request<IssuedPersonalAccessTokenDTO>(routes.rotatePersonalAccessToken(tokenId), { expiresAt }),
    logout: async () => { await request<void>(routes.authLogout, {}); csrfToken = '' },
    // 邮箱注册与找回（Ticket 05）：全部是未登录可用的入口，响应形状统一，不泄露邮箱是否存在。
    register: (input: { email: string; displayName: string; password: string; invitationToken?: string }) => request<AcceptedEmailDTO>(routes.authRegister, input),
    teams: (signal?: AbortSignal) => list<{ id: string; name: string; role: 'owner' | 'admin' | 'member'; memberCount: number }>(routes.teams, signal),
    createTeam: (name: string) => request<{ id: string; name: string; role: 'owner'; memberCount: number }>(routes.teams, { name }),
    teamMembers: (teamId: string, signal?: AbortSignal) => list<{ user: AccountViewDTO['user']; role: 'owner' | 'admin' | 'member'; joinedAt: string }>(routes.teamMembers(teamId), signal),
    updateTeamMemberRole: (teamId: string, userId: string, role: 'admin' | 'member') => request<{ user: AccountViewDTO['user']; role: 'admin' | 'member'; joinedAt: string }>(routes.teamMember(teamId, userId), { role }, undefined, 'PATCH'),
    removeTeamMember: (teamId: string, userId: string) => request<void>(routes.teamMember(teamId, userId), undefined, undefined, 'DELETE'),
    transferTeamOwnership: (teamId: string, userId: string, confirmation: string) => request<{ teamId: string; ownerId: string; previousOwnerId: string }>(routes.teamOwnershipTransfer(teamId), { userId, confirmation }),
    teamInvitations: (teamId: string, signal?: AbortSignal) => list<{ id: string; email: string; role: 'admin' | 'member'; status: 'pending' | 'accepted' | 'expired' | 'revoked'; expiresAt: string }>(routes.teamInvitations(teamId), signal),
    inviteTeamMember: (teamId: string, email: string) => request<{ id: string; email: string; status: string; token: string }>(routes.teamInvitations(teamId), { email }),
    revokeTeamInvitation: (teamId: string, invitationId: string) => request<{ id: string; status: string }>(routes.teamInvitation(teamId, invitationId), undefined, undefined, 'DELETE'),
    invitation: (token: string, signal?: AbortSignal) => request<{ team: { id: string; name: string }; email: string; role: 'admin' | 'member'; status: 'pending' | 'accepted' | 'expired' | 'revoked' }>(routes.invitation(token), undefined, signal),
    acceptInvitation: (token: string) => request<{ teamId: string; role: 'owner' | 'admin' | 'member' }>(routes.acceptInvitation(token), {}),
    resendVerification: (email: string) => request<AcceptedEmailDTO>(routes.authRegisterResend, { email }),
    verifyEmail: async (token: string) => {
      // 验证成功同时签发了 Cookie 会话，因此这里和登录一样接住 CSRF 令牌。
      const account = await request<VerifiedEmailDTO>(routes.authVerifyEmail, { token })
      csrfToken = account.csrfToken
      return account
    },
    forgotPassword: (email: string) => request<AcceptedEmailDTO>(routes.authForgotPassword, { email }),
    resetPassword: (token: string, password: string) => request<PasswordResetDTO>(routes.authResetPassword, { token, password }),
    // 账号安全（Ticket 06/08）。改密码、改邮箱与解绑都要求旧密码或近期强认证，服务端把关，前端只负责不隐藏入口。
    accountSecurity: (signal?: AbortSignal) => request<AccountSecurityViewDTO>(routes.accountSecurity, undefined, signal),
    accountLifecycle: (signal?: AbortSignal) => request<AccountLifecycleDTO>(routes.accountLifecycle, undefined, signal),
    confirmAccountDeletion: (confirmation: string) => request<{ status: 'deleted' }>(routes.accountLifecycle, { action: 'confirm-deletion', confirmation }),
    audit: (query: AuditQueryDTO = {}, signal?: AbortSignal) => { const search = new URLSearchParams(); for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value)); const suffix = search.size ? `?${search}` : ''; return request<AuditPageDTO>(`${routes.accountAudit}${suffix}`, undefined, signal) },
    auditExportUrl: (query: AuditQueryDTO = {}) => { const search = new URLSearchParams(); for (const [key, value] of Object.entries(query)) if (value !== undefined && key !== 'cursor' && key !== 'limit') search.set(key, String(value)); return `${routes.accountAuditExport}${search.size ? `?${search}` : ''}` },
    managedAccounts: (signal?: AbortSignal) => list<ManagedAccountDTO>(routes.managedAccounts, signal),
    manageAccount: (userId: string, action: 'disable' | 'restore' | 'request-deletion' | 'confirm-deletion') => request<{ status: 'ok' }>(routes.managedAccountAction(userId, action), {}),
    changePassword: (body: { currentPassword?: string; newPassword: string }) => request<PasswordChangeDTO>(routes.authPasswordChange, body),
    requestEmailChange: (body: { newEmail: string; currentPassword?: string }) => request<EmailChangeAcceptedDTO>(routes.authEmailChange, body),
    // 确认链接在未登录的浏览器里也可能被打开：这是公开路由，成功即已换好邮箱，不再签发新会话。
    confirmEmailChange: (token: string) => request<EmailChangeConfirmedDTO>(routes.authEmailChangeConfirm, { token }),
    // 绑定用整页跳转（与登录同一套 state/nonce/PKCE），回调把结果写回地址栏。
    startGoogleLink: (returnTo?: string) => request<GoogleLinkStartDTO>(routes.authGoogleLinkStart, returnTo ? { returnTo } : {}),
    unbindLoginMethod: (methodId: string, body: { currentPassword?: string }) => request<LoginMethodUnboundDTO>(routes.authIdentity(methodId), body, undefined, 'DELETE'),
    registrationPolicy: (signal?: AbortSignal) => request<RegistrationPolicyViewDTO>(routes.registrationPolicy, undefined, signal),
    setRegistrationPolicy: (policy: RegistrationPolicyDTO) => request<RegistrationPolicyViewDTO>(routes.registrationPolicy, { policy }, undefined, 'PATCH'),
    logoutAll: async () => { const result = await request<{ revoked: number }>(routes.authLogoutAll, {}); csrfToken = ''; return result },
    createEnrollmentToken: (body: CreateEnrollmentTokenDTO) => request<EnrollmentTokenDTO>(routes.enrollmentTokens, body),
    tailnet: (signal?: AbortSignal) => request<TailnetInfoDTO>(routes.tailnet, undefined, signal),
    resources: (signal?: AbortSignal) => list<Resource>(routes.resources, signal),
    resourcePresets: (signal?: AbortSignal) => request<{ items: NodeResourcePreset[] }>(routes.resourcePresets, undefined, signal),
    createResourcePreset: (body: { id: string; name: string; description: string; expectedRevision: number; entries: readonly NodeResourcePresetEntry[]; autoApply: { enabled: false } }) => request<NodeResourcePreset>(routes.resourcePresets, body),
    resourcePresetApplications: (signal?: AbortSignal) => request<{ items: { application: NodeResourcePresetApplication; items: { binding: ResourceBinding; reconcile: ReconcileReport | null }[] }[] }>(routes.resourcePresetApplications, undefined, signal),
    applyResourcePreset: (presetId: string, body: { presetRevision: number; workerId: string; requestId: string; expectedSetRevision: number }) => request<NodeResourcePresetApplication>(routes.resourcePresetApplicationsFor(presetId), body),
    resourceSet: (workerId: string, signal?: AbortSignal) => request<ResourceSetSnapshot>(routes.resourceSet(workerId), undefined, signal),
    resourceDetail: (resourceId: string, signal?: AbortSignal) => request<{ resource: Resource; revisions: ResourceRevision[] }>(routes.resource(resourceId), undefined, signal),
    createResource: (resource: Resource) => request<Resource>(routes.resources, resource),
    putResourceBlob: (sha256: string, base64Content: string) => request<{ sha256: string; deduplicated: boolean }>(routes.resourceBlob(sha256), { base64Content }, undefined, 'PUT'),
    publishResourceRevision: (resourceId: string, revision: ResourceRevision) => request<ResourceRevision>(routes.resourceRevisions(resourceId), revision),
    publishProviderRevision: (resourceId: string, body: { expectedVersion: number; revision: ResourceRevision }) => request<ResourceRevision>(`${routes.resource(resourceId)}/provider-revisions`, body),
    resourceBindings: (signal?: AbortSignal) => list<{ binding: ResourceBinding; reconcile: ReconcileReport | null }>(routes.resourceBindings, signal),
    providerCandidates: (workerId: string, projectId: string, agentKey: string, signal?: AbortSignal) => list<{ modelId: string; resourceId: string; bindingId: string; status: 'not-verified' }>(`/api/workers/${id(workerId)}/projects/${id(projectId)}/provider-candidates?agentKey=${encodeURIComponent(agentKey)}`, signal),
    bindResource: (body: { id: string; workerId: string; resourceRevisionId: string; agentKey: string | null; projectId: string | null }) => request<ResourceBinding>(routes.resourceBindings, body),
    transitionResourceBinding: (bindingId: string, status: ResourceBindingStatus, expectedRevision: number) => request<ResourceBinding>(routes.resourceBinding(bindingId), { status, expectedRevision }, undefined, 'PATCH'),
    workers: async (signal?: AbortSignal) => {
      const workers = await list<WorkerDTO>(routes.workers, signal)
      return Promise.all(workers.map(async worker => {
        const capabilityResult = await request<{ workerId: string; capabilities: WorkerDTO['capabilities'] }>(routes.capabilities(worker.id), undefined, signal)
        return { ...worker, capabilities: capabilityResult.capabilities }
      }))
    },
    projects: (signal?: AbortSignal) => list<ProjectDTO>(routes.projects, signal),
    connectors: (projectId: string, signal?: AbortSignal) => request<ConnectorListDTO>(routes.connectors(projectId), undefined, signal),
    createConnector: (projectId: string, body: ConnectorWriteDTO) => request<ConnectorDTO>(routes.connectors(projectId), body),
    updateConnector: (projectId: string, connectorId: string, body: ConnectorWriteDTO) => request<ConnectorDTO>(routes.connector(projectId, connectorId), body, undefined, 'PUT'),
    setConnectorEnabled: (projectId: string, connectorId: string, enabled: boolean, body: { requestId: string; expectedRevision: number }) => request<ConnectorDTO>(routes.connectorState(projectId, connectorId, enabled ? 'enable' : 'disable'), body),
    testConnector: (projectId: string, connectorId: string, body: ConnectorTestDTO) => request<{ requestId: string; connectorId: string; workerId: string; revision: number; status: string }>(routes.connectorState(projectId, connectorId, 'test'), body),
    channels: (projectId: string, signal?: AbortSignal) => request<ChannelListDTO>(routes.channels(projectId), undefined, signal),
    createChannel: (projectId: string, body: CreateChannelDTO) => request<CreatedChannelDTO>(routes.channels(projectId), body),
    testChannel: (projectId: string, channelId: string) => request<{ ok: true; appIdHint?: string; clientIdHint?: string; endpoint?: string }>(routes.channelTest(projectId, channelId), {}),
    setChannelEnabled: (projectId: string, channelId: string, body: { requestId: string; expectedRevision: number; enabled: boolean }) => request<unknown>(routes.channelState(projectId, channelId), body),
    rotateChannelToken: (projectId: string, channelId: string, body: RotateChannelTokenDTO) => request<CreatedChannelDTO>(routes.channelTokenRotation(projectId, channelId), body),
    deleteChannel: (projectId: string, channelId: string, body: DeleteChannelDTO) => request<DeletedChannelDTO>(routes.channel(projectId, channelId), body, undefined, 'DELETE'),
    createChannelBinding: (projectId: string, body: CreateChannelBindingDTO) => request<unknown>(routes.channelBindings(projectId), body),
    setChannelBindingEnabled: (projectId: string, bindingId: string, body: { requestId: string; expectedRevision: number; enabled: boolean }) => request<unknown>(routes.channelBindingState(projectId, bindingId), body),
    replayChannelDelivery: (projectId: string, deliveryId: string, body: { requestId: string; reason: string }) => request<unknown>(routes.channelReplay(projectId, deliveryId), body),
    projectGrants: (projectId: string, signal?: AbortSignal) => list<{ projectId: string; userId: string; role: 'viewer' | 'contributor' | 'manager' }>(routes.projectGrants(projectId), signal),
    updateProjectAccess: (projectId: string, shareScope: ProjectDTO['shareScope']) => request<ProjectDTO>(routes.projectAccess(projectId), { shareScope }, undefined, 'PATCH'),
    grantProject: (projectId: string, userId: string, role: 'viewer' | 'contributor' | 'manager') => request<{ projectId: string; userId: string; role: string }>(routes.projectGrants(projectId), { userId, role }),
    revokeProjectGrant: (projectId: string, userId: string) => request<void>(routes.projectGrant(projectId, userId), undefined, undefined, 'DELETE'),
    workspaces: async (projectId: string, signal?: AbortSignal) => (await list<WorkspaceDTO>(routes.workspaces, signal)).filter(item => item.projectId === projectId),
    workspacesAll: (signal?: AbortSignal) => list<WorkspaceDTO>(routes.workspaces, signal),
    sessions: async (projectId: string, signal?: AbortSignal) => (await list<SessionResourceDTO>(routes.sessions, signal)).filter(item => item.projectId === projectId).map(toSummary),
    sessionsAll: async (signal?: AbortSignal) => (await list<SessionResourceDTO>(routes.sessions, signal)).map(toSummary),
    commands: (signal?: AbortSignal) => list<CommandDTO>(`${routes.commands}?limit=200`, signal),
    cancelCommand: (commandId: string) => request<CommandDTO>(routes.command(commandId), undefined, undefined, 'DELETE'),
    // These session-scoped routes are distinct from deleting an undelivered control command.
    stopTurn: (sessionId: string, turnId: string, commandId: string) => request<CommandResultDTO>(routes.stopTurn(sessionId), { commandId, turnId }, undefined, 'POST'),
    cancelQueued: (sessionId: string, submissionCommandId: string, commandId: string) => request<CommandResultDTO>(routes.cancelQueued(sessionId, submissionCommandId), { commandId }, undefined, 'POST'),
    invokeRuntimeCommand: (sessionId: string, body: RuntimeCommandDTO) => request<CommandResultDTO>(routes.runtimeCommands(sessionId), body),
    resolveApproval: (sessionId: string, approvalId: string, body: ApprovalDecisionDTO) => request<CommandResultDTO>(routes.runtimeApproval(sessionId, approvalId), body),
    listSessionFiles: (sessionId: string, subpath = '', signal?: AbortSignal) => request<FileListDTO>(routes.sessionFilesList(sessionId), { subpath }, signal),
    readSessionFile: (sessionId: string, subpath: string, maxBytes = 1024 * 1024, signal?: AbortSignal) => request<FileReadDTO>(routes.sessionFilesRead(sessionId), { subpath, maxBytes }, signal),
    writeSessionFile: (sessionId: string, subpath: string, base64Content: string, signal?: AbortSignal) => request<FileWriteDTO>(routes.sessionFilesWrite(sessionId), { subpath, base64Content }, signal, undefined, 60_000),
    diffSessionFile: (sessionId: string, subpath: string, signal?: AbortSignal) => request<FileDiffDTO>(routes.sessionFilesDiff(sessionId), { subpath }, signal),
    createTerminal: (sessionId: string, cols = 80, rows = 24) => request<{ terminalId: string; pid: number }>(routes.sessionTerminal(sessionId), { cols, rows }),
    writeTerminal: (sessionId: string, terminalId: string, data: string) => request<unknown>(routes.sessionTerminalAction(sessionId, terminalId, 'write'), { data }),
    resizeTerminal: (sessionId: string, terminalId: string, cols: number, rows: number) => request<unknown>(routes.sessionTerminalAction(sessionId, terminalId, 'resize'), { cols, rows }),
    disposeTerminal: (sessionId: string, terminalId: string) => request<unknown>(routes.sessionTerminalAction(sessionId, terminalId, 'dispose'), {}),
    patchSession: async (sessionId: string, body: PatchSessionDTO) => toSummary(await request<SessionResourceDTO>(routes.session(sessionId), body, undefined, 'PATCH')),
    renameSession: async (sessionId: string, title: string) => toSummary(await request<SessionResourceDTO>(routes.session(sessionId), { title }, undefined, 'PATCH')),
    deleteSession: (sessionId: string) => request<unknown>(routes.deleteSession(sessionId), undefined, undefined, 'DELETE'),
    sessionGrants: (sessionId: string, signal?: AbortSignal) => list<{ sessionId: string; userId: string }>(routes.sessionGrants(sessionId), signal),
    updateSessionAccess: async (sessionId: string, shareScope: NonNullable<SessionDTO['shareScope']>) => toSummary(await request<SessionResourceDTO>(routes.sessionAccess(sessionId), { shareScope }, undefined, 'PATCH')),
    grantSession: (sessionId: string, userId: string) => request<{ sessionId: string; userId: string }>(routes.sessionGrants(sessionId), { userId }),
    revokeSessionGrant: (sessionId: string, userId: string) => request<void>(routes.sessionGrant(sessionId, userId), undefined, undefined, 'DELETE'),
    workerGrants: (workerId: string, signal?: AbortSignal) => list<{ workerId: string; userId: string; role: 'use' | 'manage' }>(routes.workerGrants(workerId), signal),
    updateWorkerAccess: (workerId: string, shareScope: WorkerDTO['shareScope']) => request<WorkerDTO>(routes.workerAccess(workerId), { shareScope }, undefined, 'PATCH'),
    grantWorker: (workerId: string, userId: string, role: 'use' | 'manage') => request<{ workerId: string; userId: string; role: 'use' | 'manage' }>(routes.workerGrants(workerId), { userId, role }),
    revokeWorkerGrant: (workerId: string, userId: string) => request<void>(routes.workerGrant(workerId, userId), undefined, undefined, 'DELETE'),
    revokeWorker: (workerId: string) => request<WorkerDTO>(routes.revokeWorker(workerId), {}, undefined, 'POST'),
    addWorkspacePlacement: async (workspaceId: string, workerId: string) => (await request<{ workspace: WorkspaceDTO }>(routes.workspacePlacements(workspaceId), { workerId }, undefined, 'POST')).workspace,
    reprovisionWorkspace: async (workspaceId: string, workerId?: string) => (await request<{ workspace: WorkspaceDTO }>(routes.reprovisionWorkspace(workspaceId), workerId ? { workerId } : {}, undefined, 'POST')).workspace,
    session: async (sessionId: string, signal?: AbortSignal) => toSummary(await request<SessionResourceDTO>(routes.session(sessionId), undefined, signal)),
    createProject: (body: CreateProjectDTO) => request<ProjectDTO>(routes.projects, body),
    createWorkspace: async (projectId: string, body: CreateWorkspaceDTO) => (await request<{ workspace: WorkspaceDTO }>(routes.workspaces, { ...body, projectId })).workspace,
    createSession: async (body: CreateSessionDTO) => toSummary((await request<{ session: SessionResourceDTO }>(routes.createSession, body)).session),
    // Match Wemux: the composer waits only for the enqueue acknowledgement.
    // Agent execution continues through the journal/SSE lifecycle.
    send: (sessionId: string, body: SendMessageDTO, signal?: AbortSignal) => request<SendResultDTO>(routes.messages(sessionId), body, signal, 'POST', 15000),
    command: (commandId: string, signal?: AbortSignal) => request<{ status: 'pending' | 'accepted' | 'rejected'; receipt: { error?: { message: string } } | null }>(routes.command(commandId), undefined, signal),
    async events(sessionId: string, afterSeq: number, signal?: AbortSignal) {
      const page = await request<ServerEventsPageDTO>(`${routes.events(sessionId)}?fromSeq=${afterSeq + 1}&limit=500`, undefined, signal)
      if (!Array.isArray(page.events) || !(page.nextSeq === null || Number.isInteger(page.nextSeq)) || !page.freshness) {
        throw new ApiError('API 契约错误：无效的 events 分页响应。')
      }
      return { events: page.events, throughSeq: page.events.at(-1)?.seq ?? afterSeq, hasMore: page.nextSeq !== null, freshness: page.freshness } satisfies EventsPageDTO & { freshness: ServerEventsPageDTO['freshness'] }
    },
    watchProject(projectId: string, onEvent: (event: import('@wemux/web-contract/task-platform').ProjectEvent) => void, onState: (state: 'live' | 'reconnecting') => void) {
      const controller = new AbortController()
      const signal = AbortSignal.any([scope.signal, controller.signal])
      void (async () => {
        while (!signal.aborted) {
          try {
            const url = new URL(`/api/projects/${id(projectId)}/events`, window.location.origin)
            if (config.teamId) url.searchParams.set('teamId', config.teamId)
            const response = await fetch(url, { headers: { Accept: 'text/event-stream' }, credentials: 'same-origin', signal })
            if (response.status === 401) unauthorized()
            if (signal.aborted) break
            if (!response.ok || !response.body) throw new ApiError(`Project SSE HTTP ${response.status}`)
            onState('live')
            const reader = response.body.getReader(), decoder = new TextDecoder()
            let buffer = ''
            try {
              while (!signal.aborted) {
                const chunk = await reader.read()
                if (chunk.done) break
                buffer += decoder.decode(chunk.value, { stream: true })
                buffer = buffer.replaceAll('\r\n', '\n')
                let boundary: number
                while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                  const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
                  const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
                  if (data && !signal.aborted) {
                    const event = JSON.parse(data) as import('@wemux/web-contract/task-platform').ProjectEvent
                    if (event.projectId === projectId && typeof event.type === 'string') onEvent(event)
                    else onState('live') // Unknown/gap notification: authoritative resync.
                  }
                }
              }
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
          } catch { if (signal.aborted) break }
          if (!signal.aborted) { onState('reconnecting'); await delay(1000, signal).catch(() => {}) }
        }
      })()
      return () => controller.abort()
    },
    watch(sessionId: string, afterSeq: number, onChange: () => void, onState: (state: 'live' | 'reconnecting') => void) {
      const controller = new AbortController()
      const signal = AbortSignal.any([scope.signal, controller.signal])
      void (async () => {
        let cursor = afterSeq
        while (!signal.aborted) {
          try {
            const url = new URL(routes.stream(sessionId), window.location.origin)
            url.searchParams.set('fromSeq', String(cursor + 1))
            const response = await fetch(url, {
              headers: { Accept: 'text/event-stream' },
              credentials: 'same-origin',
              signal,
            })
            if (response.status === 401) unauthorized()
            if (signal.aborted) break
            if (!response.ok || !response.body) throw new ApiError(`SSE 请求失败：HTTP ${response.status}`, response.status)
            onState('live'); onChange()
            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            while (!signal.aborted) {
              const chunk = await reader.read()
              if (chunk.done) break
              buffer += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n')
              let boundary = buffer.indexOf('\n\n')
              while (boundary >= 0) {
                const frame = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                const eventId = frame.split('\n').find(line => line.startsWith('id:'))?.slice(3).trim()
                if (eventId && Number.isInteger(Number(eventId))) cursor = Math.max(cursor, Number(eventId))
                if (frame.split('\n').some(line => line.startsWith('data:'))) onChange()
                boundary = buffer.indexOf('\n\n')
              }
            }
          } catch {
            if (signal.aborted) break
          }
          if (!signal.aborted) {
            onState('reconnecting')
            await delay(1000, signal).catch(() => {})
          }
        }
      })()
      return () => controller.abort()
    },
  }
}
// The current backend is explicitly a single-admin MVP. No implicit multi-user ACL fallback.
// When summary/ACL views ship, replace this resource adapter rather than changing UI components.
function toSummary(resource: SessionResourceDTO): SessionDTO {
  return { id: resource.id, projectId: resource.projectId, ownerId: resource.ownerId, title: resource.title, storageMode: resource.storageMode ?? 'local', workspaceId: resource.workspaceId,
    workerId: resource.binding.agent.workerId, agentKey: resource.binding.agent.agentKey,
    modelId: resource.binding.modelId, runtimeState: resource.runtimeState, archivedAt: resource.archivedAt ?? null, activeTurnId: null,
    queuedMessageCount: null, freshness: { status: 'unknown' }, updatedAt: '',
    access: resource.access, shareScope: resource.shareScope,
    canRead: resource.access?.canRead ?? true, sendCapability: resource.sendCapability,
    canSend: resource.access?.canWrite === false ? false : resource.sendCapability?.allowed === true,
    canManage: resource.access?.canControl ?? true }
}
export type Api = ReturnType<typeof createApi>
