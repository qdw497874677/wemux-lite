import type { AccountViewDTO, AccountPayloadDTO, AcceptedEmailDTO, VerifiedEmailDTO, LoginSessionDTO, PersonalAccessTokenDTO, PersonalAccessTokenScopeDTO, IssuedPersonalAccessTokenDTO, PasswordResetDTO, AccountSecurityViewDTO, AccountLifecycleDTO, AuditQueryDTO, AuditPageDTO, ManagedAccountDTO, PasswordChangeDTO, EmailChangeAcceptedDTO, EmailChangeConfirmedDTO, GoogleLinkStartDTO, LoginMethodUnboundDTO, RegistrationPolicyViewDTO, RegistrationPolicyDTO } from '@wemux/web-contract/browser-host'
import type { createClusterTransport } from './cluster-transport.ts'

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
  teams: '/api/teams',
  teamMembers: (teamId: string) => `/api/teams/${id(teamId)}/members`,
  teamMember: (teamId: string, userId: string) => `/api/teams/${id(teamId)}/members/${id(userId)}`,
  teamOwnershipTransfer: (teamId: string) => `/api/teams/${id(teamId)}/ownership-transfer`,
  teamInvitations: (teamId: string) => `/api/teams/${id(teamId)}/invitations`,
  teamInvitation: (teamId: string, invitationId: string) => `/api/teams/${id(teamId)}/invitations/${id(invitationId)}`,
  invitation: (token: string) => `/api/team-invitations/${id(token)}`,
  acceptInvitation: (token: string) => `/api/team-invitations/${id(token)}/accept`,
}

/** Existing account/team contracts over the shared Cookie/CSRF identity transport. */
export function accountManagementOperations(transport: ReturnType<typeof createClusterTransport>) {
  const { request, list, setCsrfToken } = transport
  return {
    // Google 登录（Ticket 07）：拿到授权地址后由调用方整页跳转，会话仍由回调写入 HttpOnly Cookie。
    startGoogleSignIn: (returnTo?: string) => request<{ authorizeUrl: string; expiresAt: string }>(routes.authGoogleStart, returnTo ? { returnTo } : {}),
    loginSessions: (signal?: AbortSignal) => list<LoginSessionDTO>(routes.loginSessions, signal),
    revokeLoginSession: (sessionId: string) => request<void>(routes.loginSession(sessionId), undefined, undefined, 'DELETE'),
    personalAccessTokens: (signal?: AbortSignal) => list<PersonalAccessTokenDTO>(routes.personalAccessTokens, signal),
    createPersonalAccessToken: (body: { name: string; scopes: PersonalAccessTokenScopeDTO[]; expiresAt: string }) => request<IssuedPersonalAccessTokenDTO>(routes.personalAccessTokens, body),
    revokePersonalAccessToken: (tokenId: string) => request<void>(routes.personalAccessToken(tokenId), undefined, undefined, 'DELETE'),
    rotatePersonalAccessToken: (tokenId: string, expiresAt: string) => request<IssuedPersonalAccessTokenDTO>(routes.rotatePersonalAccessToken(tokenId), { expiresAt }),
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
      setCsrfToken(account.csrfToken)
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
    logoutAll: () => request<{ revoked: number }>(routes.authLogoutAll, {}),
  }
}
