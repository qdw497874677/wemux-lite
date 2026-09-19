import type { Run, LaunchRequest, LaunchResponse, TaskSummary, TaskDetail, TaskCreate, TaskPatch, TaskActivity, AssignmentRequest, CreateTaskWorkspaceRequest, UnbindWorkspaceRequest } from '@wemux/web-contract/task-platform'
import { randomId } from '../lib/random.ts'
import { readDeviceId } from '../lib/device-scope.ts'
import type {
  ApprovalDecisionDTO, RuntimeCommandDTO, PatchSessionDTO, CommandResultDTO,
  AccountPayloadDTO, AccountViewDTO, AcceptedEmailDTO, AccountSecurityViewDTO, AuthOptionsDTO, CommandDTO, CreateEnrollmentTokenDTO, CreateProjectDTO,
  CreateSessionDTO, CreateWorkspaceDTO, EmailChangeAcceptedDTO, EmailChangeConfirmedDTO, EnrollmentTokenDTO, EventsPageDTO, GoogleLinkStartDTO, LoginMethodUnboundDTO, LoginSessionDTO, PasswordChangeDTO, PasswordResetDTO, ProjectDTO,
  RegistrationPolicyDTO, RegistrationPolicyViewDTO, SendMessageDTO, SendResultDTO, SessionDTO, SessionResourceDTO, ServerEventsPageDTO, TailnetInfoDTO, VerifiedEmailDTO, WorkerDTO, WorkspaceDTO,
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
  registrationPolicy: '/api/settings/registration-policy',
  loginSessions: '/api/auth/sessions',
  loginSession: (sessionId: string) => `/api/auth/sessions/${id(sessionId)}`,
  enrollmentTokens: '/api/enrollment-tokens',
  tailnet: '/api/cluster/tailnet',
  workers: '/api/workers',
  capabilities: (workerId: string) => `/api/workers/${id(workerId)}/capabilities`,
  revokeWorker: (workerId: string) => `/api/workers/${id(workerId)}/revoke`,
  projects: '/api/projects',
  workspaces: '/api/workspaces',
  workspacePlacements: (workspaceId: string) => `/api/workspaces/${id(workspaceId)}/placements`,
  reprovisionWorkspace: (workspaceId: string) => `/api/workspaces/${id(workspaceId)}/reprovision`,
  sessions: '/api/sessions',
  createSession: '/api/sessions',
  session: (sessionId: string) => `/api/sessions/${id(sessionId)}`,
  deleteSession: (sessionId: string) => `/api/sessions/${id(sessionId)}`,
  messages: (sessionId: string) => `/api/sessions/${id(sessionId)}/messages`,
  stopTurn: (sessionId: string) => `/api/sessions/${id(sessionId)}/turn/stop`,
  cancelQueued: (sessionId: string, submissionCommandId: string) => `/api/sessions/${id(sessionId)}/messages/${id(submissionCommandId)}/cancel`,
  runtimeCommands: (sessionId: string) => `/api/sessions/${id(sessionId)}/runtime/commands`,
  runtimeApproval: (sessionId: string, approvalId: string) => `/api/sessions/${id(sessionId)}/runtime/approvals/${id(approvalId)}`,
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
    loginSessions: (signal?: AbortSignal) => list<LoginSessionDTO>(routes.loginSessions, signal),    revokeLoginSession: (sessionId: string) => request<void>(routes.loginSession(sessionId), undefined, undefined, 'DELETE'),
    logout: async () => { await request<void>(routes.authLogout, {}); csrfToken = '' },
    // 邮箱注册与找回（Ticket 05）：全部是未登录可用的入口，响应形状统一，不泄露邮箱是否存在。
    register: (input: { email: string; displayName: string; password: string }) => request<AcceptedEmailDTO>(routes.authRegister, input),
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
    workers: async (signal?: AbortSignal) => {
      const workers = await list<WorkerDTO>(routes.workers, signal)
      return Promise.all(workers.map(async worker => {
        const capabilityResult = await request<{ workerId: string; capabilities: WorkerDTO['capabilities'] }>(routes.capabilities(worker.id), undefined, signal)
        return { ...worker, capabilities: capabilityResult.capabilities }
      }))
    },
    projects: (signal?: AbortSignal) => list<ProjectDTO>(routes.projects, signal),
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
    patchSession: async (sessionId: string, body: PatchSessionDTO) => toSummary(await request<SessionResourceDTO>(routes.session(sessionId), body, undefined, 'PATCH')),
    renameSession: async (sessionId: string, title: string) => toSummary(await request<SessionResourceDTO>(routes.session(sessionId), { title }, undefined, 'PATCH')),
    deleteSession: (sessionId: string) => request<unknown>(routes.deleteSession(sessionId), undefined, undefined, 'DELETE'),
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
  return { id: resource.id, projectId: resource.projectId, title: resource.title, workspaceId: resource.workspaceId,
    workerId: resource.binding.agent.workerId, agentKey: resource.binding.agent.agentKey,
    modelId: resource.binding.modelId, runtimeState: resource.runtimeState, archivedAt: resource.archivedAt ?? null, activeTurnId: null,
    queuedMessageCount: null, freshness: { status: 'unknown' }, updatedAt: '',
    canRead: true, sendCapability: resource.sendCapability, canSend: resource.sendCapability?.allowed === true, canManage: true }
}
export type Api = ReturnType<typeof createApi>
