import { QuickConversation, QuickStartRecovery } from './components/quick-conversation.tsx'
import { ClusterControls } from './features/sessions/cluster-controls.tsx'
import { PendingApprovalPanel } from './features/sessions/pending-approval-panel.tsx'
import { QuickStartController, fillQuickChoices, initialQuickConfig, quickKey, readPreference } from './features/sessions/quick-start.ts'
import { ProjectQuickNav } from './components/project-quick-nav'
import { ProjectResources } from './components/project-resources'
import { useProject } from './app/use-project'
import { LayerStatus, RunLayerContext, type RunLayers } from './app/layers'
import { ProjectActivity, ProjectOverview } from './features/tasks/project-pages'
import { ConnectorPage } from './features/connectors/connector-page.tsx'
import { SkillStudio } from './features/skills/skill-studio.tsx'
import { ChannelPage } from './features/channels/channel-page.tsx'
import { TaskBoard } from './features/tasks/board'
import { ApprovalsPage } from './features/approvals/approvals-page.tsx'
import { AttentionPage } from './features/attention/attention-page.tsx'
import { useAttention } from './features/attention/use-attention.ts'
import { TimelinePage } from './features/timeline/timeline-page.tsx'
import { isExecutable } from './lib/capability'
import { Component, createContext, lazy, Suspense, useContext } from 'react'
import type { ReactNode } from 'react'
import { Outlet } from '@tanstack/react-router'
import { SubmissionController } from './features/sessions/submission'
import { AppShell, MainCanvas, InspectorHost } from './app/shell'
import { resolveSelection } from './app/selection'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { RouterProvider, useRouterState, useNavigate } from '@tanstack/react-router'
import { makeRouter } from './app/router'
import { isHostPathAllowed } from './app/host-paths.ts'
import { discoverHost, type HostBootstrap } from './hosts/bootstrap.ts'
import { useResources } from './app/resources'
import { TimelineEntry, Composer, OptimisticMessages, useMessageActions } from './features/sessions/conversation'
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from './components/ai-elements/conversation.tsx'
import { SessionInfoPanel } from './features/panels/session-info-panel.tsx'
import { SessionCanvasPanel } from './features/panels/session-canvas-panel.tsx'
import { FilesPanel } from './features/files/files-panel.tsx'
import { TerminalPanel } from './features/terminal/terminal-panel.tsx'
import { AgentsPanel } from './features/agents/agents-panel.tsx'
import type { AgentPanelEntry } from './features/agents/model.ts'
import { RightPanelSheet } from './features/panels/right-panel-sheet.tsx'
import { RightPanelTabs } from './features/panels/right-panel-tabs.tsx'
import type { PanelDescriptor } from './features/panels/panel-registry.ts'
import { CommandPalette } from './features/command-palette/command-palette.tsx'
import { SessionCanvas } from './features/session-canvas/session-canvas.tsx'
import { Sidebar, ContextPanel } from './features/sessions/navigation'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Blocks, Bot, ChevronDown, ChevronRight, CircleCheck, CircleX, Files, FolderGit2, Inbox, Info, Layers, LoaderCircle, MessageSquarePlus, MoreHorizontal, PanelRight, Plus, RefreshCw, Send, Server, ServerCog, Settings2, TerminalSquare, Users, Workflow, Wrench, WifiOff } from 'lucide-react'
import { ApiError, anonymousSession, createApi, isSignedIn, type AccountSession, type Api } from './api/client'
import { retireLegacyCredentials } from './lib/device-scope'
import type { ProjectDTO, SendMessageDTO, SessionDTO, WorkerDTO, WorkspaceDTO } from './api/dto'
import { useSession } from './api/use-session'
import type { TimelineTool } from './api/journal'
import { Button } from './components/ui/button'
import { ConfirmDialogProvider } from './components/ui/confirm-dialog.tsx'
import { Badge } from './components/ui/badge'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import { Sidebar as AppSidebar, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuItem, SidebarMenuLink, SidebarProvider, SidebarRail, SidebarText, SidebarTrigger, useSidebar } from './components/ui/sidebar.tsx'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './components/ui/dropdown-menu'
import { ConnectionDialog } from './components/connection-dialog'
import { LandingScreen } from './components/landing'
import { AuthLinkScreen, readLinkToken } from './components/auth-link'
import { AccountSettingsRoute } from './components/account-page'
import { TeamInvitationScreen } from './components/team-invitation'
import { TeamPage } from './components/team-page'
import { ProjectAccessPanel } from './components/project-access.tsx'
import { toAccountSession } from './components/auth-form'
import type { AccountPayloadDTO } from './api/dto'
import { CreateDialog, type CreateKind } from './components/create-dialog'
import { WorkerEnrollmentDialog } from './components/worker-enrollment-dialog'
import { ClusterPage } from './components/cluster-page'
// 组件展示页（含 21st.dev 导入的 framer-motion 组件、整套 ui 演示）不进首屏包：
// 只有访问 /components 时才拉对应 chunk。
import { cn } from './lib/utils'
import { runtimeStateLabel, workerStateLabel, workspaceStateLabel } from './lib/display'
import { createPanelLifetime } from './lib/panel-lifetime.ts'
import { installShortcutListener, registerShortcut } from './lib/shortcuts.ts'

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : '请求失败'
const ComponentLibrary = lazy(() => import('./components/component-library.tsx').then(module => ({ default: module.ComponentLibrary })))
// 懒加载 chunk 可能在旧页面里过期（重新部署后 hash 变了），此时给一个可恢复的提示，
// 而不是让路由报错页把用户送回去。
class LazyBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (!this.state.failed) return this.props.children
    return <div role="alert" className="grid gap-2 p-6 text-sm"><p>组件展示页加载失败，可能是版本已更新。</p><button type="button" className="w-fit underline" onClick={() => window.location.reload()}>重新加载</button></div>
  }
}
function ComponentLibraryRoute() {
  return <LazyBoundary><Suspense fallback={<p role="status" className="p-6 text-sm text-muted-foreground">正在加载组件展示…</p>}><ComponentLibrary /></Suspense></LazyBoundary>
}
const freshnessLabels = { unknown: '历史完整性尚未确认', syncing: '正在补传历史', synced: '历史已同步', gap: '历史存在事件缺口', offline: '工作节点离线，仅展示缓存', orphaned: '工作节点已丢失，仅可读取缓存' }
type ConnectionState = 'connecting' | 'connected' | 'unauthorized' | 'unreachable' | 'offline'

export function App() {
  // TanStack history decodes on construction, before route error boundaries exist.
  try { decodeURIComponent(window.location.pathname) } catch { return <p role="alert">链接无效。<a href="/projects">返回项目列表</a></p> }
  return <RouterApp />
}
function RouterApp() {
  const [host, setHost] = useState<HostBootstrap | null>(null)
  const [failure, setFailure] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    void discoverHost(abort.signal).then(setHost, error => {
      if (!abort.signal.aborted) setFailure(error instanceof Error ? error.message : '无法识别工作台宿主')
    })
    return () => abort.abort()
  }, [attempt])
  const router = useMemo(() => host && makeRouter(
    host.hostKind === 'cluster' ? AuthScope : LocalHostPlaceholder,
    host.hostKind === 'cluster' ? RoutedWorkbench : LocalHostPlaceholder,
    host.hostKind,
  ), [host])
  if (failure) return <main role="alert" className="p-6">{failure} <button type="button" onClick={() => { setFailure(''); setAttempt(value => value + 1) }}>重试</button></main>
  if (!router) return <main role="status" className="p-6">正在识别工作台宿主…</main>
  return <ConfirmDialogProvider><RouterProvider router={router} /></ConfirmDialogProvider>
}
function LocalHostPlaceholder() {
  const pathname = useRouterState({ select: state => state.location.pathname })
  if (!isHostPathAllowed('local-worker', pathname)) return <main role="alert" className="p-6">链接不存在。<a href="/local">返回本地工作台</a></main>
  return <main role="status" className="p-6">本地工作台仍由 Worker 提供。共享会话界面尚未启用，请使用 Worker 当前页面。</main>
}
type BootState = 'checking' | 'ready' | 'signed-out' | 'unreachable'
const ConnectionContext = createContext<{ config: AccountSession; onSettings: () => void; onUnauthorized: () => void; onSignOut: () => void } | null>(null)
function RoutedWorkbench() {
  const connection = useContext(ConnectionContext)
  const location = useRouterState({ select: state => state.location })
  if (location.pathname === '/components') return <ComponentLibraryRoute />
  return connection ? <Workbench {...connection} /> : null
}
/**
 * 认证作用域：浏览器的登录凭据只存在于 HttpOnly Cookie，页面内存只保存账号展示信息与 CSRF 令牌。
 * 刷新页面后通过 `GET /api/auth/me` 重建会话；首屏与登录过程见 `components/landing.tsx`。
 */
function AuthScope() {
  const [config, setConfig] = useState<AccountSession>(anonymousSession)
  const [boot, setBoot] = useState<BootState>('checking')
  const [notice, setNotice] = useState('')
  const [generation, setGeneration] = useState(0)
  const [settings, setSettings] = useState(false)
  const [expired, setExpired] = useState(false)
  const [client, setClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 2000 } } }))
  useEffect(() => {
    // 旧版本把令牌存在 localStorage；Ticket 04 起改为 Cookie 会话，启动时明确退役并提示重新登录。
    const retired = retireLegacyCredentials()
    const api = createApi(anonymousSession())
    let active = true
    void (async () => {
      try {
        const account = await api.currentAccount()
        if (!active) return
        setConfig(toAccountSession(account)); setBoot('ready')
        if (retired) setNotice('已清除旧版本保存在本机的访问令牌，当前会话改由 HttpOnly Cookie 维护。')
      } catch (cause) {
        if (!active) return
        const unauthorized = cause instanceof ApiError && cause.status === 401
        setBoot(unauthorized ? 'signed-out' : 'unreachable')
        if (retired) setNotice('已清除旧版本保存在本机的访问令牌，请使用账号密码重新登录。')
        else if (!unauthorized) setNotice(cause instanceof Error ? cause.message : '无法连接服务端')
      } finally { api.dispose() }
    })()
    return () => { active = false; api.dispose() }
  }, [])
  const resetCaches = useCallback(() => {
    void client.cancelQueries(); client.clear()
    setClient(new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 2000 } } }))
    setGeneration(value => value + 1)
  }, [client])
  const applyAccount = (account: AccountPayloadDTO) => {
    resetCaches(); setConfig(toAccountSession(account)); setBoot('ready')
    setSettings(false); setExpired(false); setNotice('您已登录。')
  }
  const signOut = useCallback(() => {
    resetCaches(); setConfig(anonymousSession()); setBoot('signed-out')
    setSettings(false); setExpired(false); setNotice('已退出登录。')
  }, [resetCaches])
  const unauthorized = useCallback(() => {
    // 会话失效不清空页面：保留当前上下文，用弹窗重新登录后整体重挂。
    resetCaches(); setExpired(true); setSettings(true); setNotice('登录会话已失效，请重新登录。')
  }, [resetCaches])
  const publicComponents = window.location.pathname === '/components'
  const invitationToken = window.location.pathname === '/join' ? new URLSearchParams(window.location.search).get('token') ?? '' : ''
  const signedIn = boot === 'ready' && isSignedIn(config)
  // 邮箱验证与重置链接必须能在未登录状态打开；未登录时它们优先于落地页。
  const linkKind = window.location.pathname === '/auth/verify-email' ? 'verify' as const : window.location.pathname === '/auth/password/reset' ? 'reset' as const : window.location.pathname === '/auth/confirm-email-change' ? 'change_email' as const : null
  const goHome = useCallback((message?: string) => {
    window.history.replaceState(null, '', '/')
    if (message) setNotice(message)
    setBoot('signed-out')
  }, [])
  return <QueryClientProvider client={client}>
    {publicComponents ? <Outlet />
      : invitationToken ? <TeamInvitationScreen token={invitationToken} session={signedIn ? config : null} onAuthenticated={applyAccount} />
      : boot === 'checking' ? <main className="landing-root grain-overlay"><p role="status" className="text-sm text-muted-foreground">正在连接服务端…</p></main>
        : linkKind && !signedIn ? <AuthLinkScreen kind={linkKind} token={readLinkToken(window.location.search)} onAuthenticated={applyAccount} onGoLogin={() => goHome()} />
          : signedIn ? <ConnectionContext.Provider key={generation} value={{ config, onUnauthorized: unauthorized, onSettings: () => setSettings(true), onSignOut: signOut }}><Outlet /></ConnectionContext.Provider>
            : <LandingScreen notice={notice} onAuthenticated={applyAccount} />}
    {signedIn && settings && <ConnectionDialog session={config} expired={expired} onClose={() => setSettings(false)} onSignedIn={applyAccount} onSignOut={signOut} />}
  </QueryClientProvider>
}

function LeasedSessionSurface({ api, session, agent, revision, controller, connected, browserOnline, workerOnline, active, onOpenPanel }: { api: Api; session: SessionDTO; agent?: WorkerDTO['capabilities'][number]; revision: number; controller: SubmissionController; connected: boolean; browserOnline: boolean; workerOnline: boolean; active: boolean; onOpenPanel: () => void }) {
  const history = useSession(api, session.id, revision)
  const confirmed = history.messages.map(item => item.id)
  const canSend = Boolean(connected && browserOnline && session.access?.canWrite !== false && session.sendCapability?.allowed)
  const blockedReason = !browserOnline ? '浏览器当前离线' : !connected ? '尚未连接服务端' : session.access?.canWrite === false ? '当前账号只有查看权限' : session.sendCapability?.allowed ? '' : session.sendCapability?.reason ?? 'Authoritative capability data unavailable'
  const { hiddenMessageIds, localNotice, messageActions } = useMessageActions(controller, session.id, canSend)
  return <section hidden={!active} data-session-surface={session.id} className="absolute inset-0 flex min-h-0 min-w-0 flex-col">
    {history.error && <p role="alert" className="px-4 py-3 text-sm text-red-300">{history.error} 当前历史可能不完整。</p>}
    <Conversation className="conversation-timeline" aria-live="polite" aria-relevant="additions text"><ConversationContent className="conversation-content mx-auto w-full max-w-[var(--chat-max-width)]">{!history.timeline.length && <ConversationEmptyState title={history.checkedAt ? canSend ? '暂无消息，可以开始对话。' : blockedReason : '正在加载会话历史…'} />}{history.timeline.filter(entry => !hiddenMessageIds.has(entry.id)).map(entry => <TimelineEntry key={entry.id} entry={entry} api={api} sessionId={session.id} onOpenContext={onOpenPanel} messageActions={messageActions} />)}{localNotice && <p role="status" className="text-center text-xs text-muted-foreground">{localNotice}</p>}<OptimisticMessages controller={controller} confirmedIds={confirmed} hiddenMessageIds={hiddenMessageIds} messageActions={messageActions} /></ConversationContent><ConversationScrollButton /></Conversation>
    <ClusterControls api={api} session={session} queuedItems={history.queuedItems} enabled={connected && browserOnline && workerOnline && history.freshness?.status === 'synced' && !history.error} />
    <PendingApprovalPanel api={api} session={session} pendingApprovals={history.pendingApprovals} enabled={connected && browserOnline && workerOnline && history.freshness?.status === 'synced' && !history.error} />
    <Composer api={api} controller={controller} session={session} agent={agent} activeTurnId={history.activeTurnId} canSend={canSend} blockedReason={blockedReason} confirmedIds={confirmed} />
  </section>
}

function Workbench({ config, onSettings, onUnauthorized, onSignOut }: { config: AccountSession; onSettings: () => void; onUnauthorized: () => void; onSignOut: () => void }) {
  return <SidebarProvider><WorkbenchContent config={config} onSettings={onSettings} onUnauthorized={onUnauthorized} onSignOut={onSignOut} /></SidebarProvider>
}

function WorkbenchContent({ config, onSettings, onUnauthorized, onSignOut }: { config: AccountSession; onSettings: () => void; onUnauthorized: () => void; onSignOut: () => void }) {
  const api = useMemo(() => createApi(config, onUnauthorized), [config, onUnauthorized])
  const attentionQuery = useAttention(api)
  useEffect(() => () => api.dispose(), [api])
  const location = useRouterState({ select: state => state.location })
  const searchText = location.searchStr || (typeof window !== 'undefined' ? window.location.search : '')
  const navigate = useNavigate()
  const go = (to: string) => { void navigate({ to }) }
  const parts = location.pathname.split('/').filter(Boolean).map(part => { try { return decodeURIComponent(part) } catch { return '' } })
  const projectId = parts[0] === 'projects' ? parts[1] ?? '' : ''
  const rawSection = parts[2] ?? 'overview'
  const section = rawSection === 'canvas' ? 'overview' : rawSection
  const canvasMode = rawSection === 'canvas' || new URLSearchParams(searchText).get('view') === 'canvas'
  const sessionId = section === 'sessions' ? parts[3] ?? '' : ''
  const canvasSearch = new URLSearchParams(searchText)
  const canvasSelection = section === 'overview' ? canvasSearch.get('session') ?? '' : ''
  const canvasInteractiveSession = canvasMode ? canvasSelection : ''
  const { toggleSidebar } = useSidebar()
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [activePanelId, setActivePanelId] = useState('session-info')
  const [wideRightPanel, setWideRightPanel] = useState(() => matchMedia('(min-width: 1280px)').matches)
  const workspaceId = section === 'workspaces' ? parts[3] ?? '' : ''
  const client = useQueryClient()
  const resources = useResources(api)
  const projectData = useProject(api, projectId)
  const graphQuery = useQuery({
    queryKey: ['session-graph', projectId],
    enabled: Boolean(projectId) && section === 'overview',
    queryFn: ({ signal }) => api.sessionGraph(projectId, signal),
  })
  const quickStarts = useRef(new Map<string, QuickStartController>())
  useEffect(() => () => { quickStarts.current.forEach(value => value.dispose()); quickStarts.current.clear() }, [api])
  const [quickSetup, setQuickSetup] = useState(false)
  const [runLayers, setRunLayers] = useState<RunLayers | null>(null)
  const workers = resources.workers.data ?? []
  const projects = resources.projects.data ?? []
  const workspaces = projectData.workspaces.data ?? []
  const sessions = (projectData.sessions.data ?? []).filter(item => item.canRead)
  const loading = resources.projects.isPending || resources.workers.isPending
  const projectLoading = Boolean(projectId) && (projectData.workspaces.isPending || projectData.sessions.isPending)
  const cause = Object.values(resources).find(item => item.error)?.error
  const error = cause ? errorText(cause) : ''
  const projectError = projectData.workspaces.error?.message || projectData.sessions.error?.message || error
  const connected = !loading && !error
  const [query] = useState('')
  const [revision, setRevision] = useState(0)
  const refreshWorkers = useCallback(() => { void client.invalidateQueries({ queryKey: ['workers'] }) }, [client])
  const [contextOpen, setContextOpen] = useState(false)
  const [createKind, setCreateKind] = useState<CreateKind | null>(null)
  const [createWorkspaceId, setCreateWorkspaceId] = useState('')
  const [pendingCreate, setPendingCreate] = useState<CreateKind | null>(null)
  useEffect(() => { setContextOpen(false) }, [sessionId, workspaceId, projectId])
  useEffect(() => { if (pendingCreate && projectId) { setCreateKind(pendingCreate); setPendingCreate(null) } }, [projectId, pendingCreate])
  const [addingWorker, setAddingWorker] = useState(false)
  const [browserOnline, setBrowserOnline] = useState(navigator.onLine)
  const submissions = useRef(new Map<string, SubmissionController>())
  const submission = (id: string) => { let value = submissions.current.get(id); if (!value) { value = new SubmissionController(api, id); submissions.current.set(id, value) } return value }
  useEffect(() => () => { submissions.current.forEach(value => value.dispose()); submissions.current.clear() }, [api])
  // Session surfaces are leased instead of keyed directly by the route. Hidden
  // surfaces stay mounted for 30 seconds, preserving scroll and local UI state.
  const sessionLifetimeRef = useRef<ReturnType<typeof createPanelLifetime> | null>(null)
  if (!sessionLifetimeRef.current) sessionLifetimeRef.current = createPanelLifetime()
  const sessionLifetime = sessionLifetimeRef.current
  const retainedSessionKey = useSyncExternalStore(sessionLifetime.subscribe, () => sessionLifetime.retainedKeys().join('\u0000'), () => '')
  const selection = !loading && !projectLoading && !error ? resolveSelection(location.pathname, location.searchStr, projects, workspaces, sessions) : {}
  const validSelection = !loading && !projectLoading && !error && !selection.error
  useEffect(() => {
    if (!validSelection || !sessionId) return
    const lease = sessionLifetime.acquire(sessionId)
    return lease.release
  }, [sessionId, sessionLifetime, validSelection])
  useEffect(() => () => sessionLifetime.dispose(), [sessionLifetime])
  const retainedSessionIds = retainedSessionKey ? retainedSessionKey.split('\u0000') : []
  const selected = validSelection ? sessions.find(item => item.id === sessionId) : undefined
  const project = projects.find(item => item.id === projectId)
  const workspace = validSelection ? workspaces.find(item => item.id === (workspaceId || selected?.workspaceId)) : undefined
  const worker = workers.find(item => item.id === selected?.workerId)
  const visibleSessionIds = new Set([...retainedSessionIds, ...(selected ? [selected.id] : [])])
  const retainedSessions = [...visibleSessionIds].map(id => sessions.find(item => item.id === id)).filter((item): item is SessionDTO => Boolean(item))

  useEffect(() => {
    const online = () => { setBrowserOnline(navigator.onLine); if (navigator.onLine) setRevision(value => value + 1) }
    window.addEventListener('online', online); window.addEventListener('offline', online)
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', online) }
  }, [])
  useEffect(() => {
    const media = matchMedia('(min-width: 1280px)')
    const update = () => setWideRightPanel(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => installShortcutListener(), [])
  useEffect(() => registerShortcut({ combo: 'Mod+K', scope: 'global', description: '打开命令面板', priority: 400, allowInEditable: true, handler: () => setCommandPaletteOpen(value => !value) }), [])
  useEffect(() => registerShortcut({ combo: 'Mod+B', scope: 'panel', description: '切换右侧面板', allowInEditable: true, handler: () => setRightPanelOpen(value => !value) }), [])
  useEffect(() => {
    if (!rightPanelOpen) return
    return registerShortcut({ combo: 'Escape', scope: 'panel', description: '关闭右侧面板', priority: 300, allowInEditable: true, handler: () => setRightPanelOpen(false) })
  }, [rightPanelOpen])

  useEffect(() => { if (selection.redirect) void navigate({ to: selection.redirect, replace: true }) }, [selection.redirect, navigate])
  const projectBase = `/projects/${encodeURIComponent(projectId)}`
  const refresh = useCallback(() => { setRevision(value => value + 1); void client.invalidateQueries() }, [client])
  const quickController = () => {
    let controller = quickStarts.current.get(projectId)
    if (!controller) {
      const key = quickKey(api.launchScope, projectId)
      controller = new QuickStartController(api, projectId, key, initialQuickConfig(projectId, workspaces, workers, readPreference(window.localStorage, key)), window.sessionStorage, window.localStorage)
      quickStarts.current.set(projectId, controller)
    }
    return controller
  }
  const openQuickSession = (id: string) => { refresh(); go(`${projectBase}/sessions/${encodeURIComponent(id)}`) }
  const quickEntry = !loading && !projectLoading && !projectError && project && <QuickConversation key={`${projectId}:${section}`} controller={quickController()} projectId={projectId} workers={workers} workspaces={workspaces} connected={connected && browserOnline} onSetup={() => { setQuickSetup(true); if (!workers.length) setAddingWorker(true); else openResource('workspace') }} onOpen={openQuickSession} />
  const resourceList = <div className="space-y-4">{workspaces.filter(ws => !workspaceId || ws.id === workspaceId).map(ws => <section key={ws.id} className="rounded-xl border border-white/10 bg-card p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><a className="font-medium text-foreground hover:underline" href={`${projectBase}/workspaces/${encodeURIComponent(ws.id)}`} onClick={event => { event.preventDefault(); go(`${projectBase}/workspaces/${encodeURIComponent(ws.id)}`) }}>{ws.name}</a><p className="mt-1 text-sm text-muted-foreground">{workspaceStateLabel[ws.status]} · {workers.find(item => item.id === ws.workerId)?.name ?? ws.workerId}</p>{ws.location?.rootPath && <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{ws.location.rootPath}</p>}</div><Button variant="outline" size="sm" disabled={!connected || ws.status !== 'ready'} onClick={() => openResource('session', ws.id)}>新建会话</Button></div><p className="mt-2 text-xs text-muted-foreground">{sessions.filter(item => item.workspaceId === ws.id).length} 个会话</p>{workspaceId && sessions.filter(item => item.workspaceId === ws.id).map(item => <a className="mt-2 block rounded-lg bg-muted/50 px-3 py-2 text-sm text-foreground hover:bg-muted" key={item.id} href={`${projectBase}/sessions/${encodeURIComponent(item.id)}`} onClick={event => { event.preventDefault(); go(`${projectBase}/sessions/${encodeURIComponent(item.id)}`) }}>{item.title}</a>)}</section>)}{!workspaces.length && <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-card/50 px-6 py-12 text-center"><div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl border border-primary/20 bg-primary/10"><Layers className="size-6 text-primary" /></div><p className="text-sm font-medium text-foreground">暂无工作区</p><p className="mt-1 text-xs text-muted-foreground">创建工作区后，即可在对应节点上启动会话。</p><Button className="mt-4" disabled={!connected} onClick={() => openResource('workspace')}>新建工作区</Button></div>}</div>
  const featurePageClass = 'mx-auto w-full max-w-6xl space-y-4 py-3 sm:py-4'
  const page = <section className={cn('min-h-0 flex-1 overflow-auto', section === 'sessions' ? 'flex px-3 py-6 sm:px-6' : parts[0] === 'teams' || parts[0] === 'cluster' ? '' : 'px-3 sm:px-5')}>
    {parts[0] === 'attention' ? <AttentionPage api={api} /> : parts[0] === 'approvals' ? <ApprovalsPage projects={projects} /> : parts[0] === 'timeline' ? <TimelinePage projects={projects} /> : parts[0] === 'teams' ? <TeamPage api={api} onBack={() => go('/projects')} /> : parts[0] === 'cluster' ? <ClusterPage api={api} connected={connected} canEnrollWorkers={config.instanceAdministrator} onAddWorker={() => setAddingWorker(true)} onRefresh={refresh} /> : selection.error ? <p role="alert">{selection.error}</p> : (loading || projectLoading) && !projectError ? <p role="status">正在加载资源…</p> : parts[0] === 'components' ? <ComponentLibraryRoute /> : parts[0] === 'settings' ? <AccountSettingsRoute api={api} session={config} onSignOut={onSignOut} onOpenConnection={onSettings} /> : ['runtime', 'runtimes'].includes(parts[0]) ? <div className={featurePageClass}><header className="flex min-h-10 items-center justify-between border-b border-border pb-2"><div><h1 className="text-sm font-medium">运行时</h1><p className="text-xs text-muted-foreground">{workers.length} 个节点 · {workers.reduce((sum, item) => sum + item.capabilities.length, 0)} 个智能体</p></div><Button variant="outline" size="sm" onClick={() => go('/cluster')}>查看集群</Button></header></div> : !projectId ? <div className={featurePageClass}><header className="flex min-h-10 items-center justify-between gap-3 border-b border-border pb-2"><div><h1 className="text-sm font-medium">项目</h1><p className="text-xs text-muted-foreground">选择项目，查看工作区与对话。</p></div><Button size="icon-sm" disabled={!connected} aria-label="新建项目" title="新建项目" onClick={() => openResource('project')}><Plus className="size-4" /></Button></header><div className="space-y-1">{projects.map(item => <a key={item.id} className="group flex items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-muted" href={`/projects/${encodeURIComponent(item.id)}/sessions`} onClick={event => { event.preventDefault(); go(`/projects/${encodeURIComponent(item.id)}/sessions`) }}><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><FolderGit2 className="size-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.name}</span><span className="block truncate text-xs text-muted-foreground">打开项目工作区与会话</span></span><ChevronRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" /></a>)}{!loading && !error && !projects.length && <div className="flex min-h-60 flex-col items-center justify-center text-center"><span className="mb-3 grid size-10 place-items-center rounded-lg bg-muted"><FolderGit2 className="size-5 text-muted-foreground" /></span><p className="text-sm font-medium">暂无项目</p><p className="mt-1 text-xs text-muted-foreground">创建第一个项目后即可添加工作区并开始对话。</p><Button size="sm" className="mt-4" disabled={!connected} onClick={() => openResource('project')}>新建项目</Button></div>}</div></div> : section === 'board' || section === 'tasks' ? <TaskBoard key={projectId} api={api} projectId={projectId} taskId={section === 'tasks' ? parts[3] ?? new URLSearchParams(location.searchStr).get('task') ?? '' : ''} search={location.searchStr} go={go} /> : section === 'activity' ? <ProjectActivity projectId={projectId} data={projectData} /> : section === 'connectors' ? <ConnectorPage api={api} projectId={projectId} workers={workers} canManage={project?.accessRole === 'owner' || project?.accessRole === 'manager'} /> : section === 'skills' ? <SkillStudio key={projectId} api={api} canManage={config.instanceAdministrator} projectId={projectId} workers={workers} connected={connected} /> : section === 'channels' ? <ChannelPage api={api} projectId={projectId} sessions={sessions.filter(item => item.projectId === projectId)} canManage={project?.accessRole === 'owner' || project?.accessRole === 'manager'} /> : section === 'settings' ? <><h1>项目设置</h1><p>名称：{project?.name}</p><p className="break-all">项目 ID：{projectId}</p>{project && <ProjectAccessPanel api={api} project={project} onChanged={refresh} />}</> : section === 'sessions' ? <div className="m-auto w-full">{quickEntry}</div> : <><h1>{section === 'overview' ? canvasMode ? '协作画布' : '概览' : workspaceId ? workspaces.find(item => item.id === workspaceId)?.name : '工作区'}</h1><p>{workspaces.length} 个工作区 · {sessions.length} 个会话 · {new Set(workspaces.map(item => item.workerId)).size} 个工作节点</p><Button disabled={!connected} onClick={() => openResource('workspace')}>新建工作区</Button>{section === 'overview' && !canvasMode ? <><SessionCanvas api={api} projectId={projectId} graph={graphQuery.data?.graph ?? null} selectedSessionId={canvasSelection} interactiveSessionId="" loading={graphQuery.isPending} error={graphQuery.error ? errorText(graphQuery.error) : ''} onRetry={() => void graphQuery.refetch()} onSelect={id => go(`${projectBase}?session=${encodeURIComponent(id)}`)} onActivate={id => go(`${projectBase}?session=${encodeURIComponent(id)}&view=canvas`)} onOpen={id => go(`${projectBase}/sessions/${encodeURIComponent(id)}?from=canvas`)} /><ProjectResources base={projectBase} workspaces={workspaces} sessions={sessions} workers={workers} go={go} /><ProjectOverview projectId={projectId} data={projectData} /></> : canvasMode ? <SessionCanvas api={api} projectId={projectId} graph={graphQuery.data?.graph ?? null} selectedSessionId={canvasSelection} interactiveSessionId={canvasInteractiveSession} loading={graphQuery.isPending} error={graphQuery.error ? errorText(graphQuery.error) : ''} onRetry={() => void graphQuery.refetch()} onSelect={id => go(`${projectBase}?session=${encodeURIComponent(id)}&view=canvas`)} onActivate={id => go(`${projectBase}?session=${encodeURIComponent(id)}&view=canvas`)} onOpen={id => go(`${projectBase}/sessions/${encodeURIComponent(id)}?from=canvas`)} /> : resourceList}</>}
  </section>
  const canSend = Boolean(connected && browserOnline && selected?.access?.canWrite !== false && selected?.sendCapability?.allowed)
  const visibleSessions = sessions.filter(item => !item.archivedAt)
  const connectionState: ConnectionState = !browserOnline ? 'offline' : loading ? 'connecting' : connected ? 'connected' : error.includes('401') || error.includes('令牌') ? 'unauthorized' : 'unreachable'
  const connectionLabel = { connecting: '正在连接服务端', connected: '服务端已连接', unauthorized: '管理员令牌无效', unreachable: '无法访问服务端', offline: '浏览器离线' }[connectionState]
  const sendBlockedReason = !browserOnline ? '浏览器当前离线' : !connected ? '尚未连接服务端' : selected?.access?.canWrite === false ? '当前账号只有查看权限' : selected?.sendCapability?.allowed ? '' : selected?.sendCapability?.reason ?? 'Authoritative capability data unavailable'
  const startConversationWithAgent = useCallback((entry: AgentPanelEntry) => {
    const current = workspace?.placements.some(placement => placement.workerId === entry.workerId) ? workspace : undefined
    const target = current ?? workspaces.find(item => item.projectId === projectId && item.placements.some(placement => placement.workerId === entry.workerId && placement.status === 'ready'))
    const controller = quickController()
    controller.resetCompleted()
    controller.configure({ workspaceId: target?.id ?? '', workerId: entry.workerId, agentKey: entry.agentKey, modelId: '' })
    go(`${projectBase}/sessions`)
  }, [projectBase, projectId, workspace, workspaces])
  const panelDescriptors = useMemo<PanelDescriptor[]>(() => selected ? [
    { id: 'session-info', icon: Info, title: '会话信息', render: () => <SessionInfoPanel api={api} session={selected} workspace={workspace} worker={worker} project={project} onChanged={refresh} /> },
    { id: 'agents', icon: Bot, title: '智能体', keepAlive: false, render: () => <AgentsPanel workers={workers} onStartConversation={startConversationWithAgent} /> },
    { id: 'session-canvas', icon: Workflow, title: '画布', render: () => <SessionCanvasPanel session={selected} onOpenCanvas={() => go(`${projectBase}/overview?session=${encodeURIComponent(selected.id)}&view=canvas`)} /> },
    { id: 'files', icon: Files, title: '文件', keepAlive: true, render: () => <FilesPanel api={api} sessionId={selected.id} /> },
    { id: 'terminal', icon: TerminalSquare, title: '终端', keepAlive: true, render: () => <TerminalPanel api={api} sessionId={selected.id} active={activePanelId === 'terminal'} /> },
  ] : [], [activePanelId, api, project, refresh, selected, startConversationWithAgent, worker, workers, workspace])
  const rightPanel = selected && panelDescriptors.length ? <RightPanelTabs descriptors={panelDescriptors} activeId={activePanelId} context={{ sessionId: selected.id }} onActivate={setActivePanelId} onClose={() => setRightPanelOpen(false)} /> : null

  const openResource = (kind: CreateKind | 'session', workspaceId = '') => {
    if (kind === 'workspace' && !projectId && projects.length) {
      // Navigate to the first project's workspaces page, then open the dialog after navigation
      go(`/projects/${encodeURIComponent(projects[0].id)}/workspaces`); setPendingCreate(kind); return
    }
    if (kind === 'session') {
      const controller = quickController()
      controller.resetCompleted()
      if (workspaceId && workspaceId !== controller.state.config.workspaceId) {
        const ws = workspaces.find(item => item.id === workspaceId)
        if (ws) controller.configure(fillQuickChoices({ workspaceId: ws.id, workerId: '', agentKey: '', modelId: '' }, projectId, workspaces, workers))
      }
      go(`${projectBase}/sessions`); return
    }
    setCreateWorkspaceId(workspaceId); setCreateKind(kind)
  }
  const closeCreate = () => { setCreateKind(null); setCreateWorkspaceId('') }
  const paletteCommands = [
    { id: 'new-session', label: '新会话', description: projectId ? '在当前项目开始新对话' : '请先选择项目', disabled: !projectId || !connected, run: () => openResource('session') },
    ...[
      ['session-info', '会话信息'],
      ['session-canvas', '画布'],
      ['files', '文件'],
      ['terminal', '终端'],
      ['agents', '智能体'],
    ].map(([id, title]) => ({ id: `panel:${id}`, label: `切换面板：${title}`, description: selected ? `打开右侧${title}面板` : '请先打开一个会话', disabled: !selected, run: () => { setActivePanelId(id); setRightPanelOpen(true) } })),
    { id: 'toggle-right-panel', label: rightPanelOpen ? '折叠右侧面板' : '打开右侧面板', description: selected ? '切换当前会话的辅助面板' : '请先打开一个会话', disabled: !selected, run: () => setRightPanelOpen(value => !value) },
    { id: 'toggle-sidebar', label: '折叠或展开侧栏', description: '切换项目与会话导航侧栏', run: toggleSidebar },
  ]
  const manageSession = async (id: string, patch: { title?: string; archived?: boolean }) => {
    await api.patchSession(id, patch)
    refresh()
    if (patch.archived && id === sessionId) go(`${projectBase}/sessions`)
  }
  const sidebar = <Sidebar projects={projects} projectId={projectId} section={section} workspaces={workspaces} sessions={visibleSessions} sessionId={sessionId} query={query} loading={loading} projectLoading={projectLoading} connected={connected} onProject={id => go(`/projects/${encodeURIComponent(id)}/sessions`)} onNavigate={path => go(`/projects/${encodeURIComponent(projectId)}/${path}`)} onSession={id => go(`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(id)}`)} onCreate={openResource} onManageSession={manageSession} />

  function EmptyWorkspace() {
    const action = !connected ? { label: '连接服务端', run: onSettings } : !projects.length ? { label: '新建项目', run: () => openResource('project') } : !workspaces.length ? { label: '新建工作区', run: () => openResource('workspace') } : { label: '新建会话', run: () => openResource('session') }
    return <div className="grid min-h-full place-content-center justify-items-center gap-3 px-6 text-center"><Bot className="size-11 text-primary" /><h2 className="text-base font-semibold">{connected ? '开始一次智能体会话' : '连接 Wemux Lite 服务端'}</h2><p className="max-w-md text-sm leading-6 text-muted-foreground">{connected ? !projects.length ? '先创建项目，用来组织工作区和会话。' : !workspaces.length ? '为当前项目创建工作区，工作节点会准备仓库和执行目录。' : '工作区准备好后，选择智能体与模型创建会话。' : '输入部署服务端时设置的管理员令牌，连接后即可管理工作节点、项目与会话。'}</p><Button onClick={action.run}>{action.label}</Button></div>
  }

  const globalNavigation = <nav aria-label="全局导航"><SidebarGroup><SidebarGroupLabel>Wemux Lite</SidebarGroupLabel><SidebarMenu>{[
    { path: '/attention', label: '待办', icon: Inbox, active: parts[0] === 'attention', count: attentionQuery.data?.total ?? 0 },
    { path: '/projects', label: '项目', icon: FolderGit2, active: parts[0] === 'projects', count: 0 },
    { path: '/teams', label: '团队', icon: Users, active: parts[0] === 'teams', count: 0 },
    { path: '/runtime', label: '运行时', icon: Workflow, active: ['runtime', 'runtimes'].includes(parts[0]), count: 0 },
    { path: '/cluster', label: '集群', icon: ServerCog, active: parts[0] === 'cluster', count: 0 },
    { path: '/components', label: '组件', icon: Blocks, active: parts[0] === 'components', count: 0 },
    { path: '/settings', label: '设置', icon: Settings2, active: parts[0] === 'settings', count: 0 },
  ].map(item => <SidebarMenuItem key={item.path}><SidebarMenuLink href={item.path} aria-current={item.active ? 'page' : undefined} isActive={item.active} tooltip={item.label} onClick={event => { event.preventDefault(); go(item.path) }}><item.icon /><SidebarText>{item.label}</SidebarText>{item.count > 0 ? <span className="ml-auto rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground" data-testid="attention-nav-count">{item.count}</span> : null}</SidebarMenuLink></SidebarMenuItem>)}</SidebarMenu></SidebarGroup></nav>
  return <RunLayerContext.Provider value={setRunLayers}><AppShell>
    <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-2 sm:gap-3 sm:px-4">
      <SidebarTrigger className="md:hidden" />
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary font-black text-white">W</span><strong className="hidden text-sm sm:block">Wemux Lite</strong>
      <div className="flex-1" />
      {config.instanceAdministrator && <Button variant="outline" size="sm" className="hidden lg:inline-flex" disabled={!connected} onClick={() => setAddingWorker(true)}><ServerCog className="size-4" />添加工作节点</Button>}
      <div className="hidden items-center gap-1 sm:flex"><Button variant="ghost" size="icon" aria-label="刷新当前数据" onClick={refresh}><RefreshCw className="size-4" /></Button><Button variant="ghost" size="icon" aria-label="连接设置" onClick={onSettings}><Settings2 className="size-4" /></Button></div>
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="sm:hidden" aria-label="更多操作"><MoreHorizontal className="size-5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{config.instanceAdministrator && <DropdownMenuItem disabled={!connected} onSelect={() => setAddingWorker(true)}><ServerCog className="size-4" />添加工作节点</DropdownMenuItem>}<DropdownMenuItem onSelect={refresh}><RefreshCw className="size-4" />刷新当前数据</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={onSettings}><Settings2 className="size-4" />连接设置</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    </header>
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2 text-xs sm:px-4" role="status"><span className={connectionState === 'connected' ? 'text-emerald-300' : connectionState === 'unauthorized' ? 'text-red-300' : 'text-amber-300'}>{connectionLabel}</span>{connectionState === 'connected' && <span className="text-muted-foreground">{workers.filter(item => item.connectionState === 'online').length} / {workers.length} 个工作节点在线</span>}<details className="relative ml-auto shrink-0 text-muted-foreground"><summary className="cursor-pointer rounded px-2 py-1 text-xs">诊断</summary><div className="absolute right-0 top-full z-30 mt-2 w-64 rounded-lg border border-border bg-popover p-3 shadow-md"><LayerStatus online={browserOnline} server={loading ? 'unknown' : connected && !projectError ? 'connected' : 'stale / unreachable'} worker={runLayers ? workers.find(w => w.id === runLayers.workerId)?.connectionState ?? 'unknown' : worker?.connectionState ?? (workspace ? workers.find(w => w.id === workspace.workerId)?.connectionState ?? 'unknown' : 'N/A')} journal={runLayers?.journal ?? (sessionId ? selected?.freshness?.status ?? 'unknown' : 'N/A（无 Session）')} /></div></details>{connectionState !== 'connected' && <Button size="sm" variant="outline" onClick={onSettings}>{connectionState === 'unauthorized' ? '重新输入令牌' : '连接设置'}</Button>}</div>
    {(error || projectError || !browserOnline) && <div role="alert" className="flex shrink-0 items-start gap-2 border-b border-amber-500/25 bg-amber-500/10 px-3 py-3 text-sm text-amber-100 sm:px-4"><WifiOff className="mt-0.5 size-4 shrink-0" /><span>{!browserOnline ? '浏览器当前离线。' : error || projectError}<span className="block text-xs text-amber-200/75">页面可能显示上次加载的数据，请先恢复连接再执行管理操作。</span></span></div>}
    <div className="workbench-layout"><AppSidebar collapsible="icon"><SidebarHeader className="h-14 flex-row items-center"><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary font-black text-white">W</span><SidebarText className="font-semibold">Wemux Lite</SidebarText><SidebarTrigger className="ml-auto group-data-[state=collapsed]/sidebar-wrapper:hidden" /></SidebarHeader>{globalNavigation}{sidebar}<SidebarRail /></AppSidebar>
      <SidebarInset><MainCanvas>{projectId && !sessionId && <><ProjectQuickNav base={projectBase} name={project?.name ?? '正在加载项目…'} section={section} go={go} /><div className={cn('canvas-toolbar', section === 'sessions' && 'hidden')}><Button data-inspector-trigger size="sm" variant="ghost" onClick={() => setContextOpen(true)}>查看资源详情</Button></div></>}{(!sessionId || selection.error) ? page : <><header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-background/85 px-3 backdrop-blur-sm sm:px-4">{new URLSearchParams(location.searchStr).get('from') === 'canvas' && selected ? <Button size="sm" variant="ghost" onClick={() => go(`${projectBase}/overview?session=${encodeURIComponent(selected.id)}&view=canvas`)}>返回画布</Button> : <Button size="sm" variant="ghost" onClick={() => go(`${projectBase}/sessions`)}>返回</Button>}<div className="min-w-0"><h1 className="truncate text-sm font-medium">{selected?.title ?? project?.name ?? '智能体工作台'}</h1>{selected ? <div className="mt-0.5 flex min-w-0 items-center gap-1 overflow-hidden text-xs text-muted-foreground/60" aria-label="当前会话所属关系"><span className="truncate">{project?.name ?? selected.projectId}</span><ChevronRight className="size-3 shrink-0" /><span className="truncate">{workspace?.name ?? selected.workspaceId}</span><ChevronRight className="size-3 shrink-0" /><span className="truncate text-foreground">{selected.title}</span><span className="shrink-0 text-muted-foreground/60">·</span><Server className="size-3 shrink-0" /><span className="truncate">{worker?.name ?? selected.workerId}</span></div> : <p className="mt-1 truncate text-xs text-muted-foreground">项目 → Workspace → Session；Worker 提供执行环境</p>}</div><Button size="sm" variant="ghost" aria-pressed={rightPanelOpen} onClick={() => setRightPanelOpen(value => !value)} aria-label="切换右侧面板"><PanelRight className="size-4" />{rightPanelOpen ? '收起面板' : '打开面板'}</Button>{selected && <button className="flex shrink-0 items-center gap-2" onClick={() => setContextOpen(true)} aria-label="查看会话详情"><Badge variant={selected.runtimeState === 'running' ? 'success' : 'outline'}>{runtimeStateLabel[selected.runtimeState]}</Badge><ChevronDown className="size-4 text-muted-foreground xl:hidden" /></button>}</header>
        {selected && <details className="shrink-0 border-b border-border px-4 py-1 text-xs"><summary className="cursor-pointer py-1 text-muted-foreground">{canSend ? '会话状态' : sendBlockedReason || '暂不可发送'}{selected.queuedMessageCount ? ` · ${selected.queuedMessageCount} 条排队` : ''}</summary><div className="space-y-1 py-2" role="status"><p className={canSend ? 'text-muted-foreground' : 'text-amber-200'}>{canSend ? freshnessLabels[selected.freshness?.status ?? 'unknown'] : sendBlockedReason || freshnessLabels[selected.freshness?.status ?? 'unknown']}{selected.queuedMessageCount ? ` · ${selected.queuedMessageCount} 条消息等待执行` : ''}</p></div></details>}
        {projectId && <QuickStartRecovery controller={quickController()} sessionId={sessionId} />}
        <div className="flex min-h-0 flex-1">
          <div className="relative min-h-0 min-w-0 flex-1">
            {retainedSessions.map(item => <LeasedSessionSurface key={item.id} api={api} session={item} agent={workers.find(candidate => candidate.id === item.workerId)?.capabilities.find(candidate => candidate.agentKey === item.agentKey)} revision={revision} controller={submission(item.id)} connected={connected} browserOnline={browserOnline} workerOnline={workers.find(candidate => candidate.id === item.workerId)?.connectionState === 'online'} active={item.id === sessionId} onOpenPanel={() => { setActivePanelId('session-info'); setRightPanelOpen(true) }} />)}
          </div>
          {rightPanelOpen && wideRightPanel && <div className="w-80 shrink-0 bg-card/55">{rightPanel}</div>}
        </div>
        {!wideRightPanel && <RightPanelSheet open={rightPanelOpen} onClose={() => setRightPanelOpen(false)}>{rightPanel}</RightPanelSheet>}
      </>}</MainCanvas></SidebarInset>
      <InspectorHost open={validSelection && Boolean(projectId) && contextOpen && !['board', 'tasks'].includes(section)} onOpenChange={open => { setContextOpen(open); if (!open && workspaceId) go(`${projectBase}/workspaces`) }}>{!workspace && project && <section className="space-y-3 pb-5"><h2>{project.name}</h2><p className="break-all">项目 ID：{project.id}</p><p>{workspaces.length} 个工作区 · {sessions.length} 个会话</p></section>}{workspace && <section className="space-y-3 pb-5"><h2>{workspace.name}</h2><p>{workspaceStateLabel[workspace.status]}</p><code className="block whitespace-pre-wrap break-all">{workspace.location?.rootPath ?? '等待报告路径'}</code>{workspace.failureReason && <p role="alert">{workspace.failureReason}</p>}<Button disabled={!connected || workspace.status !== 'ready'} onClick={() => openResource('session', workspace.id)}>新建会话</Button></section>}<ContextPanel selected={selected} workspace={workspace} workers={validSelection ? workers.filter(item => item.id === workspace?.workerId) : []} connected={connected} onAddWorker={() => setAddingWorker(true)} onOpenCluster={() => go('/cluster')} /></InspectorHost>
    </div>

    <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} projectId={projectId} sessions={visibleSessions} commands={paletteCommands} onOpenSession={id => go(`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(id)}`)} />
    {addingWorker && <WorkerEnrollmentDialog api={api} workers={workers} onRefreshWorkers={refreshWorkers} onClose={() => { setAddingWorker(false); if (quickSetup) openResource('workspace') }} />}
    {createKind && <CreateDialog key={`${createKind}:${projectId}:${createWorkspaceId}`} kind={createKind} api={api} teamId={config.teamId} projectId={projectId} defaultWorkspaceId={createWorkspaceId} workers={workers} workspaces={workspaces} onClose={() => { setQuickSetup(false); closeCreate() }} onCreated={(kind, id) => { closeCreate(); refresh(); if (kind === 'project') go(`/projects/${encodeURIComponent(id)}/sessions`); else if (quickSetup) { setQuickSetup(false); void api.workspaces(projectId).then(items => { const ws = items.find(item => item.id === id); if (ws) quickController().configure(fillQuickChoices({ workspaceId: ws.id, workerId: '', agentKey: '', modelId: '' }, projectId, items, workers)) }).catch(() => { /* Keep the draft; workspace selection remains explicit after refresh. */ }); go(`${projectBase}/sessions`) } else go(`/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(id)}`) }} />}
  </AppShell></RunLayerContext.Provider>
}
