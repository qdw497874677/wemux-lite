import { classifyClientError, createClusterClient, discoverHost, toAccountSession } from '@wemux/web-client'
import type { AccountSession, HostBootstrap, ProjectDTO } from '@wemux/web-contract/browser-host'

export function errorPresentation(error: unknown) {
  const kind = classifyClientError(error)
  const messages = {
    unauthorized: ['需要重新登录', '账号或密码不正确，或登录会话已过期。请重新登录。'],
    forbidden: ['无权访问', '当前账号没有此操作的权限。请联系项目管理者或返回项目列表。'],
    'not-found': ['资源不存在', '请求的资源已删除或地址不存在。请返回项目列表。'],
    network: ['网络连接失败', '无法连接当前宿主。请检查网络，然后重试。'],
    server: ['服务暂时不可用', '服务端未能完成请求。请稍后重试；持续失败请联系管理员。'],
    contract: ['服务响应不兼容', '当前页面与宿主的响应不兼容。请刷新或联系管理员检查版本。'],
    cancelled: ['请求已取消', '可以重新发起请求。'],
    unexpected: ['页面出现异常', '页面无法正常显示。请重新加载页面，或返回项目列表。'],
  } as const
  return { kind, title: messages[kind][0], message: messages[kind][1] }
}
export type Presentation = ReturnType<typeof errorPresentation>
export type AppState = {
  phase: 'loading' | 'login' | 'ready' | 'error' | 'local-worker'
  account: AccountSession | null
  projects: ProjectDTO[]
  busy: boolean
  loggingOut: boolean
  error: Presentation | null
  notice: string
}
// A tab-local presence bit distinguishes expired reloads from first visits. It is
// only a UI hint, never identity or authorization, and storage may be unavailable.
const signedInTabKey = 'wemux.next.signed-in'
function wasSignedIn(): boolean {
  try { return globalThis.sessionStorage.getItem(signedInTabKey) === '1' } catch { return false }
}
function rememberSignedIn(signedIn: boolean) {
  try {
    if (signedIn) globalThis.sessionStorage.setItem(signedInTabKey, '1')
    else globalThis.sessionStorage.removeItem(signedInTabKey)
  } catch { /* Storage restrictions must not prevent authentication or logout. */ }
}
type Dependencies = { discover: () => Promise<HostBootstrap>; cluster: typeof createClusterClient }
export function createApplication(dependencies: Dependencies = { discover: discoverHost, cluster: createClusterClient }) {
  let state: AppState = { phase: 'loading', account: null, projects: [], busy: true, loggingOut: false, error: null, notice: '' }
  let generation = 0
  let projectRequest = 0
  let checking: Promise<void> | undefined
  let client: ReturnType<typeof createClusterClient> | undefined
  let authenticatedAccountId: string | undefined
  const listeners = new Set<() => void>()
  const update = (patch: Partial<AppState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()) }
  const retire = () => { generation++; client?.dispose(); client = undefined; authenticatedAccountId = undefined }
  const expire = () => { retire(); update({ phase: 'login', account: null, projects: [], busy: false, loggingOut: false, error: null, notice: '登录会话已过期或已失效，请重新登录。登录后将重新核验当前页面的访问权限。' }) }
  const adopt = (account: Parameters<typeof toAccountSession>[0]) => {
    retire()
    const session = toAccountSession(account)
    authenticatedAccountId = account.user.id
    client = dependencies.cluster(session, expire, {}, authenticatedAccountId)
    rememberSignedIn(true)
    update({ account: session, phase: 'ready', projects: [], loggingOut: false, error: null, notice: '' })
  }
  async function loadProjects() {
    if (!client || !state.account || state.loggingOut) return
    const token = generation, request = ++projectRequest
    update({ busy: true, projects: [], error: null })
    try { const projects = await client.projects(); if (token === generation && request === projectRequest) update({ projects, busy: false }) }
    catch (error) { if (token === generation && request === projectRequest) { if (classifyClientError(error) === 'unauthorized') expire(); else update({ busy: false, projects: [], error: errorPresentation(error) }) } }
  }
  // Recheck the whole application, not only the panel that observed membership loss.
  // Retire revoked scopes before fetching again so late old-scope responses cannot repopulate commands.
  function revalidateAccess(): Promise<void> {
    if (checking) return checking
    if (!client || !state.account || state.phase !== 'ready' || state.loggingOut) return Promise.resolve()
    const token = generation, active = client
    projectRequest++
    update({ projects: [], busy: true, error: null })
    checking = (async () => {
      try {
        const teams = await active.teams()
        if (token !== generation) return
        if (state.account?.teamId && !teams.some(team => team.id === state.account!.teamId)) {
          await selectTeam('')
        } else await loadProjects()
      } catch (error) {
        if (token === generation) {
          if (classifyClientError(error) === 'unauthorized') expire()
          else update({ projects: [], busy: false, error: errorPresentation(error) })
        }
      }
    })().finally(() => { checking = undefined })
    return checking
  }
  async function start() {
    retire(); const token = generation
    update({ phase: 'loading', account: null, projects: [], busy: true, loggingOut: false, error: null })
    try {
      const host = await dependencies.discover()
      if (token !== generation) return
      if (host.hostKind === 'local-worker') { update({ phase: 'local-worker', busy: false }); return }
      client = dependencies.cluster()
      const account = await client.currentAccount()
      if (token !== generation) return
      adopt(account); await loadProjects()
    } catch (error) {
      if (token !== generation) return
      if (classifyClientError(error) === 'unauthorized' && wasSignedIn()) { expire(); return }
      retire()
      update({ phase: classifyClientError(error) === 'unauthorized' ? 'login' : 'error', busy: false, error: classifyClientError(error) === 'unauthorized' ? null : errorPresentation(error) })
    }
  }
  async function login(login: string, password: string) {
    if (state.busy || state.phase !== 'login') return
    retire(); const token = generation
    client = dependencies.cluster()
    update({ busy: true, error: null })
    try {
      const account = await client.login(login, password)
      if (token !== generation) return
      adopt(account); await loadProjects()
    } catch (error) { if (token === generation) { retire(); update({ busy: false, error: errorPresentation(error) }) } }
  }
  async function selectTeam(teamId: string) {
    if (!state.account || state.loggingOut) return
    const account = { ...state.account, teamId }
    const accountId = authenticatedAccountId
    retire(); authenticatedAccountId = accountId
    client = dependencies.cluster(account, expire, {}, authenticatedAccountId)
    update({ account, projects: [], error: null })
    await loadProjects()
  }
  async function logout() {
    if (!client || !state.account || state.phase !== 'ready' || state.loggingOut) return
    const token = ++generation
    ++projectRequest
    const active = client
    update({ busy: true, loggingOut: true, projects: [], error: null })
    try {
      await active.logout()
      if (token !== generation) return
      rememberSignedIn(false)
      retire(); update({ phase: 'login', account: null, projects: [], busy: false, loggingOut: false, error: null, notice: '已退出登录。' })
    } catch (error) { if (token === generation) update({ busy: false, loggingOut: false, error: errorPresentation(error) }) }
  }
  return { start, login, logout, loadProjects, selectTeam, getClient: () => client, revalidateAccess, getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, dispose: () => { retire(); listeners.clear() } }
}
export type Application = ReturnType<typeof createApplication>

export function safeReturnTarget(target: string | null): string {
  if (!target || !target.startsWith('/next/') || target.includes('\\') || /%2f|%5c/i.test(target)) return '/next/projects'
  try {
    const url = new URL(target, 'http://wemux.invalid')
    if (url.origin !== 'http://wemux.invalid' || !url.pathname.startsWith('/next/') || url.pathname === '/next/login') return '/next/projects'
    return `${url.pathname}${url.search}${url.hash}`
  } catch { return '/next/projects' }
}
export function resolveRoute(pathname: string): { kind: 'projects' | 'login' | 'not-found' | 'settings' | 'teams' | 'join' | 'auth-link' | 'attention' } | { kind: 'project'; projectId: string } {
  if (['/next/', '/next/projects', '/next/projects/'].includes(pathname)) return { kind: 'projects' }
  if (pathname === '/next/settings') return { kind: 'settings' }
  if (pathname === '/next/attention') return { kind: 'attention' }
  if (pathname === '/next/teams') return { kind: 'teams' }
  if (pathname === '/next/join') return { kind: 'join' }
  if (['/next/auth/verify-email', '/next/auth/password/reset', '/next/auth/confirm-email-change'].includes(pathname)) return { kind: 'auth-link' }
  if (pathname === '/next/login') return { kind: 'login' }
  const match = /^\/next\/projects\/([^/]+)\/?$/.exec(pathname)
  if (match) { try { return { kind: 'project', projectId: decodeURIComponent(match[1]!) } } catch { /* malformed URL is not a resource */ } }
  return { kind: 'not-found' }
}
