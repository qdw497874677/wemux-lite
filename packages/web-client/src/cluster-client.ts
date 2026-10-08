import { sessionConversationOperations } from './session-conversation.ts'
import { taskSessionOperations } from './task-sessions.ts'
import { projectManagementOperations } from './project-management.ts'
import type { AccountPayloadDTO, AccountSession, AccountViewDTO, AuthOptionsDTO, ProjectDTO } from '@wemux/web-contract/browser-host'
import { accountManagementOperations } from './account-management.ts'
import { createClusterTransport, type ClusterTransportOptions } from './cluster-transport.ts'

export const anonymousSession = (): AccountSession => ({ teamId: '', csrfToken: '', username: '', email: null, instanceAdministrator: false })
export const isSignedIn = (session: AccountSession): boolean => session.username !== ''
export function toAccountSession(account: AccountPayloadDTO | AccountViewDTO): AccountSession {
  return { teamId: account.teamId ?? '', csrfToken: account.csrfToken ?? '', username: account.user.username, email: account.user.email, instanceAdministrator: account.instanceAdministrator }
}

/** First-entry cluster operations, without any legacy UI or Session/Journal dependency. */
export function clusterAccountOperations(transport: ReturnType<typeof createClusterTransport>) {
  const { request, list, setCsrfToken } = transport
  return {
    authOptions: (signal?: AbortSignal) => request<AuthOptionsDTO>('/api/auth/options', undefined, signal),
    login: async (login: string, password: string) => {
      const account = await request<AccountPayloadDTO>('/api/auth/login', { login, password })
      setCsrfToken(account.csrfToken)
      return account
    },
    currentAccount: async (signal?: AbortSignal) => {
      const account = await request<AccountViewDTO>('/api/auth/me', undefined, signal)
      if (account.csrfToken) setCsrfToken(account.csrfToken)
      return account
    },
    logout: async () => { await request<void>('/api/auth/logout', {}); setCsrfToken('') },
    projects: (signal?: AbortSignal) => list<ProjectDTO>('/api/projects', signal),
  }
}

export function createClusterClient(config: AccountSession = anonymousSession(), onUnauthorized: () => void = () => {}, options: ClusterTransportOptions = {}, authenticatedAccountId?: string) {
  const transport = createClusterTransport(config, onUnauthorized, options)
  // Bound only by the owner after verified login/me; never infer a server ID from username.
  const accountId = typeof authenticatedAccountId === 'string' && authenticatedAccountId.trim() && authenticatedAccountId.length <= 200 && !authenticatedAccountId.includes('\0') ? authenticatedAccountId : null
  const controlIdentity = Object.freeze({ accountId, signal: transport.signal })
  return { controlIdentity, ...clusterAccountOperations(transport), ...accountManagementOperations(transport), ...projectManagementOperations(transport), ...taskSessionOperations(transport), ...sessionConversationOperations(transport), taskSessionScope: { host: new URL(options.origin ?? window.location.origin).origin, account: config.username, teamId: config.teamId }, dispose: transport.dispose }
}
