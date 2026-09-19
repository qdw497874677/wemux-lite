import { QuickConversation, QuickStartRecovery } from './components/quick-conversation.tsx'
import { ClusterControls } from './features/sessions/cluster-controls.tsx'
import { QuickStartController, fillQuickChoices, initialQuickConfig, quickKey, readPreference } from './features/sessions/quick-start.ts'
import { ProjectQuickNav } from './components/project-quick-nav'
import { ProjectResources } from './components/project-resources'
import { useProject } from './app/use-project'
import { LayerStatus, RunLayerContext, type RunLayers } from './app/layers'
import { ProjectActivity, ProjectOverview } from './features/tasks/project-pages'
import { TaskBoard } from './features/tasks/board'
import { isExecutable, capabilityLabel } from './lib/capability'
import { Component, createContext, lazy, Suspense, useContext } from 'react'
import type { ReactNode } from 'react'
import { Outlet } from '@tanstack/react-router'
import { SubmissionController } from './features/sessions/submission'
import { AppShell, GlobalRail, ProjectNavigation, MainCanvas, InspectorHost } from './app/shell'
import { resolveSelection } from './app/selection'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { RouterProvider, useRouterState, useNavigate } from '@tanstack/react-router'
import { makeRouter } from './app/router'
import { useResources } from './app/resources'
import { TimelineEntry, Composer, OptimisticMessages } from './features/sessions/conversation'
import { SessionInfoPanel } from './features/sessions/session-info-panel.tsx'
import { Sidebar, ContextPanel } from './features/sessions/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, CircleCheck, CircleX, FolderGit2, Layers, LoaderCircle, Menu, MessageSquarePlus, MoreHorizontal, Network, Plus, RefreshCw, Search, Send, Server, ServerCog, Settings2, Wrench, WifiOff } from 'lucide-react'
import { ApiError, anonymousSession, createApi, isSignedIn, type AccountSession } from './api/client'
import { retireLegacyCredentials } from './lib/device-scope'
import type { ProjectDTO, SendMessageDTO, SessionDTO, WorkerDTO, WorkspaceDTO } from './api/dto'
import { useSession } from './api/use-session'
import type { ChatMessage, ChatTimelineItem, TimelineTool } from './api/journal'
import { Button } from './components/ui/button'
import { Badge } from './components/ui/badge'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from './components/ui/sheet'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './components/ui/dropdown-menu'
import { ConnectionDialog } from './components/connection-dialog'
import { LandingScreen } from './components/landing'
import { AuthLinkScreen, readLinkToken } from './components/auth-link'
import { AccountPage } from './components/account-page'
import { toAccountSession } from './components/auth-form'
import type { AccountPayloadDTO } from './api/dto'
import { CreateDialog, type CreateKind } from './components/create-dialog'
import { WorkerEnrollmentDialog } from './components/worker-enrollment-dialog'
import { ClusterPage } from './components/cluster-page'
// 组件展示页（含 21st.dev 导入的 framer-motion 组件、整套 ui 演示）不进首屏包：
// 只有访问 /components 时才拉对应 chunk。
import { cn } from './lib/utils'
import { formatChineseTime, runtimeStateLabel, workerStateLabel, workspaceStateLabel } from './lib/display'

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
type View = 'workbench' | 'cluster'
type ConnectionState = 'connecting' | 'connected' | 'unauthorized' | 'unreachable' | 'offline'

export function App() {
  // TanStack history decodes on construction, before route error boundaries exist.
  try { decodeURIComponent(window.location.pathname) } catch { return <p role="alert">链接无效。<a href="/projects">返回项目列表</a></p> }
  return <RouterApp />
}
function RouterApp() {
  const [router] = useState(() => makeRouter(AuthScope, RoutedWorkbench))
  return <RouterProvider router={router} />
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
  const signedIn = boot === 'ready' && isSignedIn(config)
  // 邮箱验证与重置链接必须能在未登录状态打开；未登录时它们优先于落地页。
  const linkKind = window.location.pathname === '/auth/verify-email' ? 'verify' as const : window.location.pathname === '/auth/password/reset' ? 'reset' as const : null
  const goHome = useCallback((message?: string) => {
    window.history.replaceState(null, '', '/')
    if (message) setNotice(message)
    setBoot('signed-out')
  }, [])
  return <QueryClientProvider client={client}>
    {publicComponents ? <Outlet />
      : boot === 'checking' ? <main className="landing-root grain-overlay"><p role="status" className="text-sm text-muted-foreground">正在连接服务端…</p></main>
        : linkKind && !signedIn ? <AuthLinkScreen kind={linkKind} token={readLinkToken(window.location.search)} onAuthenticated={applyAccount} onGoLogin={() => goHome()} />
          : signedIn ? <ConnectionContext.Provider key={generation} value={{ config, onUnauthorized: unauthorized, onSettings: () => setSettings(true), onSignOut: signOut }}><Outlet /></ConnectionContext.Provider>
            : <LandingScreen notice={notice} onAuthenticated={applyAccount} />}
    {signedIn && settings && <ConnectionDialog session={config} expired={expired} onClose={() => setSettings(false)} onSignedIn={applyAccount} onSignOut={signOut} />}
  </QueryClientProvider>
}

function Workbench({ config, onSettings, onUnauthorized, onSignOut }: { config: AccountSession; onSettings: () => void; onUnauthorized: () => void; onSignOut: () => void }) {
  const api = useMemo(() => createApi(config, onUnauthorized), [config, onUnauthorized])
  useEffect(() => () => api.dispose(), [api])
  const location = useRouterState({ select: state => state.location })
  const navigate = useNavigate()
  const go = (to: string) => { void navigate({ to }); setNavigation(false) }
  const parts = location.pathname.split('/').filter(Boolean).map(part => { try { return decodeURIComponent(part) } catch { return '' } })
  const projectId = parts[0] === 'projects' ? parts[1] ?? '' : ''
  const section = parts[2] ?? 'overview'
  const sessionId = section === 'sessions' ? parts[3] ?? '' : ''
  const [conversationFocus, setConversationFocus] = useState(true)
  const [infoPanelOpen, setInfoPanelOpen] = useState(false)
  const workspaceId = section === 'workspaces' ? parts[3] ?? '' : ''
  const view: View = parts[0] === 'cluster' ? 'cluster' : 'workbench'
  const client = useQueryClient()
  const resources = useResources(api)
  const projectData = useProject(api, projectId)
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
  const [query, setQuery] = useState('')
  const [revision, setRevision] = useState(0)
  const refreshWorkers = useCallback(() => { void client.invalidateQueries({ queryKey: ['workers'] }) }, [client])
  const [navigation, setNavigation] = useState(false)
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
  // Optimistic echo, the Wemux applyOptimisticTurn equivalent: the submitted
  // message enters the timeline immediately; the journal projection takes over
  // once the durable message.queued event arrives (same messageId ⇒ dedup).
  const [echo, setEcho] = useState<{ sessionId: string; message: ChatMessage } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const previousTimelineSizeRef = useRef(0)
  const previousSessionRef = useRef(sessionId)
  const selection = !loading && !projectLoading && !error ? resolveSelection(location.pathname, location.searchStr, projects, workspaces, sessions) : {}
  const validSelection = !loading && !projectLoading && !error && !selection.error
  const history = useSession(api, validSelection ? sessionId : '', revision)
  const selected = validSelection ? sessions.find(item => item.id === sessionId) : undefined
  const project = projects.find(item => item.id === projectId)
  const workspace = validSelection ? workspaces.find(item => item.id === (workspaceId || selected?.workspaceId)) : undefined
  const worker = workers.find(item => item.id === selected?.workerId)

  useEffect(() => {
    const online = () => { setBrowserOnline(navigator.onLine); if (navigator.onLine) setRevision(value => value + 1) }
    const shortcut = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); document.querySelector<HTMLInputElement>('input[aria-label="搜索会话"]')?.focus() } }
    window.addEventListener('online', online); window.addEventListener('offline', online); window.addEventListener('keydown', shortcut)
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', online); window.removeEventListener('keydown', shortcut) }
  }, [])

  useEffect(() => { if (selection.redirect) void navigate({ to: selection.redirect, replace: true }) }, [selection.redirect, navigate])
  const projectBase = `/projects/${encodeURIComponent(projectId)}`
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
  const projectNavigation = <ProjectNavigation>{[['sessions', '新对话 / 会话'], ['overview', '概览'], ['board', '任务看板'], ['workspaces', '工作区'], ['activity', '活动'], ['settings', '项目设置']].map(([path, label]) => <a key={path} href={`${projectBase}/${path}`} aria-current={section === path ? 'page' : undefined} onClick={event => { event.preventDefault(); go(`${projectBase}/${path}`) }} className="rounded px-3 py-2 text-sm hover:bg-accent">{label}</a>)}</ProjectNavigation>
  const resourceList = <div className="space-y-4">{workspaces.filter(ws => !workspaceId || ws.id === workspaceId).map(ws => <section key={ws.id} className="rounded-xl border border-white/10 bg-card p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><a className="font-medium text-foreground hover:underline" href={`${projectBase}/workspaces/${encodeURIComponent(ws.id)}`} onClick={event => { event.preventDefault(); go(`${projectBase}/workspaces/${encodeURIComponent(ws.id)}`) }}>{ws.name}</a><p className="mt-1 text-sm text-muted-foreground">{workspaceStateLabel[ws.status]} · {workers.find(item => item.id === ws.workerId)?.name ?? ws.workerId}</p>{ws.location?.rootPath && <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{ws.location.rootPath}</p>}</div><Button variant="outline" size="sm" disabled={!connected || ws.status !== 'ready'} onClick={() => openResource('session', ws.id)}>新建会话</Button></div><p className="mt-2 text-xs text-muted-foreground">{sessions.filter(item => item.workspaceId === ws.id).length} 个会话</p>{workspaceId && sessions.filter(item => item.workspaceId === ws.id).map(item => <a className="mt-2 block rounded-lg bg-muted/50 px-3 py-2 text-sm text-foreground hover:bg-muted" key={item.id} href={`${projectBase}/sessions/${encodeURIComponent(item.id)}`} onClick={event => { event.preventDefault(); go(`${projectBase}/sessions/${encodeURIComponent(item.id)}`) }}>{item.title}</a>)}</section>)}{!workspaces.length && <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-card/50 px-6 py-12 text-center"><div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20"><Layers className="size-6 text-violet-400" /></div><p className="text-sm font-medium text-foreground">暂无工作区</p><p className="mt-1 text-xs text-muted-foreground">创建工作区后，即可在对应节点上启动会话。</p><Button className="mt-4" disabled={!connected} onClick={() => openResource('workspace')}>新建工作区</Button></div>}</div>
  const page = <section className={cn('min-h-0 flex-1 overflow-auto', section === 'sessions' ? 'flex px-3 py-6 sm:px-6' : 'space-y-5 p-4 sm:p-6')}>
    {selection.error ? <p role="alert">{selection.error}</p> : (loading || projectLoading) && !projectError ? <p role="status">正在加载资源…</p> : parts[0] === 'components' ? <ComponentLibraryRoute /> : parts[0] === 'settings' ? <><h1>全局设置</h1><AccountPage api={api} session={config} onSignOut={onSignOut} onOpenConnection={onSettings} /></> : ['runtime', 'runtimes'].includes(parts[0]) ? <><h1>运行时</h1>{workers.map(item => <section key={item.id} className="border-b border-border py-4"><h2>{item.name} · {workerStateLabel[item.connectionState]}</h2>{item.capabilities.map(agent => <div key={agent.agentKey} className="py-3"><strong>{agent.displayName}</strong><p>{capabilityLabel(agent)} · {agent.availability.reason}</p>{agent.models.map(model => <p key={model.modelId}>{model.displayName} · {model.modelId}</p>)}</div>)}</section>)}</> : !projectId ? <><h1>项目</h1><p>选择项目，查看工作区与对话。</p>{!loading && !error && !projects.length && <p>暂无项目，请创建第一个项目。</p>}{projects.map(item => <a key={item.id} className="block border-b border-border py-4" href={`/projects/${encodeURIComponent(item.id)}/sessions`} onClick={event => { event.preventDefault(); go(`/projects/${encodeURIComponent(item.id)}/sessions`) }}>{item.name}</a>)}<Button disabled={!connected} onClick={() => openResource('project')}>新建项目</Button></> : section === 'board' || section === 'tasks' ? <TaskBoard key={projectId} api={api} projectId={projectId} taskId={section === 'tasks' ? parts[3] ?? new URLSearchParams(location.searchStr).get('task') ?? '' : ''} search={location.searchStr} go={go} /> : section === 'activity' ? <ProjectActivity projectId={projectId} data={projectData} /> : section === 'settings' ? <><h1>项目设置</h1><p>名称：{project?.name}</p><p className="break-all">项目 ID：{projectId}</p><p>项目编辑尚未提供 API。</p></> : section === 'sessions' ? <div className="m-auto w-full">{quickEntry}</div> : <><h1>{section === 'overview' ? '概览' : workspaceId ? workspaces.find(item => item.id === workspaceId)?.name : '工作区'}</h1><p>{workspaces.length} 个工作区 · {sessions.length} 个会话 · {new Set(workspaces.map(item => item.workerId)).size} 个工作节点</p><Button disabled={!connected} onClick={() => openResource('workspace')}>新建工作区</Button>{section === 'overview' ? <><ProjectResources base={projectBase} workspaces={workspaces} sessions={sessions} workers={workers} go={go} /><ProjectOverview projectId={projectId} data={projectData} /></> : resourceList}</>}
  </section>
  const canSend = Boolean(connected && browserOnline && selected?.sendCapability?.allowed)
  const confirmed = history.messages.map(item => item.id)
  const timeline: ChatTimelineItem[] = echo && echo.sessionId === sessionId && !confirmed.includes(echo.message.id)
    ? [...history.timeline, { kind: 'message', ...echo.message }]
    : history.timeline
  useEffect(() => { if (echo && (echo.sessionId !== sessionId || history.messages.some(item => item.id === echo.message.id))) setEcho(null) }, [echo, sessionId, history.messages])
  useEffect(() => {
    const node = scrollRef.current
    const sessionChanged = previousSessionRef.current !== sessionId
    if (sessionChanged) {
      previousSessionRef.current = sessionId
      previousTimelineSizeRef.current = 0
      nearBottomRef.current = true
    }
    if (!node || (!sessionChanged && !nearBottomRef.current)) return
    const frame = requestAnimationFrame(() => node.scrollTo({ top: node.scrollHeight, behavior: previousTimelineSizeRef.current ? 'smooth' : 'auto' }))
    previousTimelineSizeRef.current = timeline.length
    return () => cancelAnimationFrame(frame)
  }, [sessionId, history.events.at(-1)?.seq, timeline])
  const trackTimelineScroll = () => {
    const node = scrollRef.current
    if (node) nearBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120
  }
  const refresh = useCallback(() => { setRevision(value => value + 1); void client.invalidateQueries() }, [client])
  const visibleSessions = sessions.filter(item => !item.archivedAt)
  const connectionState: ConnectionState = !browserOnline ? 'offline' : loading ? 'connecting' : connected ? 'connected' : error.includes('401') || error.includes('令牌') ? 'unauthorized' : 'unreachable'
  const connectionLabel = { connecting: '正在连接服务端', connected: '服务端已连接', unauthorized: '管理员令牌无效', unreachable: '无法访问服务端', offline: '浏览器离线' }[connectionState]
  const sendBlockedReason = !browserOnline ? '浏览器当前离线' : !connected ? '尚未连接服务端' : selected?.sendCapability?.allowed ? '' : selected?.sendCapability?.reason ?? 'Authoritative capability data unavailable'

  const openResource = (kind: CreateKind, workspaceId = '') => {
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
    setCreateWorkspaceId(workspaceId); setCreateKind(kind); setNavigation(false)
  }
  const closeCreate = () => { setCreateKind(null); setCreateWorkspaceId('') }
  const manageSession = async (id: string, patch: { title?: string; archived?: boolean }) => {
    await api.patchSession(id, patch)
    refresh()
    if (patch.archived && id === sessionId) go(`${projectBase}/sessions`)
  }
  const sidebar = <Sidebar projects={projects} projectId={projectId} workspaces={workspaces} workers={workers} sessions={visibleSessions} sessionId={sessionId} query={query} loading={loading} projectLoading={projectLoading} connected={connected} onQuery={setQuery} onProject={id => go(`/projects/${encodeURIComponent(id)}/sessions`)} onSession={id => go(`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(id)}`)} onCreate={openResource} onManageSession={manageSession} />

  function EmptyWorkspace() {
    const action = !connected ? { label: '连接服务端', run: onSettings } : !projects.length ? { label: '新建项目', run: () => openResource('project') } : !workspaces.length ? { label: '新建工作区', run: () => openResource('workspace') } : { label: '新建会话', run: () => openResource('session') }
    return <div className="grid min-h-full place-content-center justify-items-center gap-3 px-6 text-center"><Bot className="size-11 text-violet-300" /><h2 className="text-base font-semibold">{connected ? '开始一次智能体会话' : '连接 Wemux Lite 服务端'}</h2><p className="max-w-md text-sm leading-6 text-muted-foreground">{connected ? !projects.length ? '先创建项目，用来组织工作区和会话。' : !workspaces.length ? '为当前项目创建工作区，工作节点会准备仓库和执行目录。' : '工作区准备好后，选择智能体与模型创建会话。' : '输入部署服务端时设置的管理员令牌，连接后即可管理工作节点、项目与会话。'}</p><Button onClick={action.run}>{action.label}</Button></div>
  }

  const globalRail = <GlobalRail><a href="/projects" onClick={event => { event.preventDefault(); go('/projects') }}>项目</a><a href="/runtime" onClick={event => { event.preventDefault(); go('/runtime') }}>运行时</a><a href="/cluster" onClick={event => { event.preventDefault(); go('/cluster') }}>集群</a><a href="/components" onClick={event => { event.preventDefault(); go('/components') }}>组件</a><a href="/settings" onClick={event => { event.preventDefault(); go('/settings') }}>设置</a></GlobalRail>
  return <RunLayerContext.Provider value={setRunLayers}><AppShell>
    <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-2 sm:gap-3 sm:px-4">
      <Button variant="ghost" size="icon" className="xl:hidden" aria-label="打开项目导航" onClick={() => setNavigation(true)}><Menu className="size-5" /></Button>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-indigo-600 to-violet-600 font-black text-white">W</span><strong className="hidden text-sm sm:block">Wemux Lite</strong>
      <div className="ml-0.5 flex min-w-0 items-center rounded-lg border border-border bg-card p-0.5 sm:ml-2" aria-label="页面导航">
        <button aria-current={view === 'workbench' ? 'page' : undefined} className={cn('min-h-9 whitespace-nowrap rounded-md px-2.5 text-xs', view === 'workbench' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')} onClick={() => go('/projects')}>工作台</button>
        <button aria-current={view === 'cluster' ? 'page' : undefined} className={cn('min-h-9 whitespace-nowrap rounded-md px-2.5 text-xs', view === 'cluster' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')} onClick={() => go('/cluster')}><Network className="mr-1 hidden size-3.5 sm:inline" />集群</button>
      </div>

      <div className="flex-1" />
      <label className="relative hidden w-56 md:block"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input aria-label="搜索会话" className="w-full pl-9" placeholder="搜索会话…" value={query} onFocus={() => { if (window.matchMedia('(min-width: 1280px)').matches) setConversationFocus(false); else setNavigation(true) }} onChange={event => setQuery(event.target.value)} /></label>
      <Button variant="outline" size="sm" className="hidden lg:inline-flex" disabled={!connected} onClick={() => setAddingWorker(true)}><ServerCog className="size-4" />添加工作节点</Button>
      <div className="hidden items-center gap-1 sm:flex"><Button variant="ghost" size="icon" aria-label="刷新当前数据" onClick={refresh}><RefreshCw className="size-4" /></Button><Button variant="ghost" size="icon" aria-label="连接设置" onClick={onSettings}><Settings2 className="size-4" /></Button></div>
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="sm:hidden" aria-label="更多操作"><MoreHorizontal className="size-5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={!connected} onSelect={() => setAddingWorker(true)}><ServerCog className="size-4" />添加工作节点</DropdownMenuItem><DropdownMenuItem onSelect={refresh}><RefreshCw className="size-4" />刷新当前数据</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={onSettings}><Settings2 className="size-4" />连接设置</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    </header>
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2 text-xs sm:px-4" role="status"><span className={connectionState === 'connected' ? 'text-emerald-300' : connectionState === 'unauthorized' ? 'text-red-300' : 'text-amber-300'}>{connectionLabel}</span>{connectionState === 'connected' && <span className="text-muted-foreground">{workers.filter(item => item.connectionState === 'online').length} / {workers.length} 个工作节点在线</span>}<details className="relative ml-auto shrink-0 text-muted-foreground"><summary className="cursor-pointer rounded px-2 py-1 text-xs">诊断</summary><div className="absolute right-0 top-full z-30 mt-2 w-64 rounded-lg border border-border bg-popover p-3 shadow-md"><LayerStatus online={browserOnline} server={loading ? 'unknown' : connected && !projectError ? 'connected' : 'stale / unreachable'} worker={runLayers ? workers.find(w => w.id === runLayers.workerId)?.connectionState ?? 'unknown' : worker?.connectionState ?? (workspace ? workers.find(w => w.id === workspace.workerId)?.connectionState ?? 'unknown' : 'N/A')} journal={runLayers?.journal ?? (sessionId ? history.error ? 'stale' : history.freshness?.status ?? 'unknown' : 'N/A（无 Session）')} /></div></details>{connectionState !== 'connected' && <Button size="sm" variant="outline" onClick={onSettings}>{connectionState === 'unauthorized' ? '重新输入令牌' : '连接设置'}</Button>}</div>
    {(error || projectError || !browserOnline) && <div role="alert" className="flex shrink-0 items-start gap-2 border-b border-amber-500/25 bg-amber-500/10 px-3 py-3 text-sm text-amber-100 sm:px-4"><WifiOff className="mt-0.5 size-4 shrink-0" /><span>{!browserOnline ? '浏览器当前离线。' : error || projectError}<span className="block text-xs text-amber-200/75">页面可能显示上次加载的数据，请先恢复连接再执行管理操作。</span></span></div>}
    {view === 'cluster' ? <ClusterPage api={api} connected={connected} onAddWorker={() => setAddingWorker(true)} onRefresh={refresh} /> : <div className={cn('workbench-layout', sessionId && conversationFocus && 'conversation-focus')}>{globalRail}
      <div className="project-column">{projectId && projectNavigation}<div className="min-h-0 flex-1">{sidebar}</div></div>
      <MainCanvas>{projectId && !sessionId && <><ProjectQuickNav base={projectBase} name={project?.name ?? '正在加载项目…'} section={section} go={go} /><div className={cn('canvas-toolbar', section === 'sessions' && 'hidden')}><Button data-inspector-trigger size="sm" variant="ghost" onClick={() => setContextOpen(true)}>查看资源详情</Button></div></>}{(!sessionId || selection.error) ? page : <><header className="flex min-h-16 shrink-0 items-center justify-between gap-2 border-b border-border px-3 sm:px-4"><Button size="sm" variant="ghost" onClick={() => go(`${projectBase}/sessions`)}>返回</Button><div className="min-w-0"><h1 className="truncate text-sm font-semibold">{selected?.title ?? project?.name ?? '智能体工作台'}</h1>{selected ? <div className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden text-xs text-muted-foreground" aria-label="当前会话所属关系"><span className="truncate">{project?.name ?? selected.projectId}</span><ChevronRight className="size-3 shrink-0" /><span className="truncate">{workspace?.name ?? selected.workspaceId}</span><ChevronRight className="size-3 shrink-0" /><span className="truncate text-foreground">{selected.title}</span><span className="shrink-0 text-muted-foreground/60">·</span><Server className="size-3 shrink-0" /><span className="truncate">{worker?.name ?? selected.workerId}</span></div> : <p className="mt-1 truncate text-xs text-muted-foreground">项目 → Workspace → Session；Worker 提供执行环境</p>}</div><Button size="sm" variant="ghost" className="hidden xl:inline-flex" aria-pressed={!conversationFocus} onClick={() => setConversationFocus(value => !value)}>{conversationFocus ? '展开导航' : '专注对话'}</Button><Button size="sm" variant="ghost" aria-pressed={infoPanelOpen} onClick={() => setInfoPanelOpen(value => !value)} aria-label="切换会话信息面板">{infoPanelOpen ? '隐藏信息' : '会话信息'}</Button>{selected && <button className="flex shrink-0 items-center gap-2" onClick={() => setContextOpen(true)} aria-label="查看会话详情"><Badge variant={selected.runtimeState === 'running' ? 'success' : 'outline'}>{runtimeStateLabel[selected.runtimeState]}</Badge><ChevronDown className="size-4 text-muted-foreground xl:hidden" /></button>}</header>
        {selected && <details className="shrink-0 border-b border-border px-4 py-1 text-xs"><summary className="cursor-pointer py-1 text-muted-foreground">{canSend ? '会话状态' : sendBlockedReason || '暂不可发送'}{selected.queuedMessageCount ? ` · ${selected.queuedMessageCount} 条排队` : ''}</summary><div className="space-y-1 py-2" role="status"><p className={canSend ? 'text-muted-foreground' : 'text-amber-200'}>{canSend ? freshnessLabels[selected.freshness?.status ?? 'unknown'] : sendBlockedReason || freshnessLabels[selected.freshness?.status ?? 'unknown']}{selected.queuedMessageCount ? ` · ${selected.queuedMessageCount} 条消息等待执行` : ''}</p>{history.checkedAt > 0 && <p className="text-muted-foreground">最近核对：{formatChineseTime(history.checkedAt)}{history.stream !== 'live' ? ' · 实时更新正在重连' : ''}</p>}</div></details>}
        {projectId && <QuickStartRecovery controller={quickController()} sessionId={sessionId} />}
        {history.error && <p role="alert" className="px-4 py-3 text-sm text-red-300">{history.error} 当前历史可能不完整。</p>}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div ref={scrollRef} onScroll={trackTimelineScroll} className="conversation-timeline min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6 sm:py-6" aria-live="polite" aria-relevant="additions text">{!selected ? <EmptyWorkspace /> : <div className="conversation-content space-y-5">{!timeline.length && <p className="py-8 text-center text-sm text-muted-foreground">{history.checkedAt ? canSend ? '暂无消息，可以开始对话。' : sendBlockedReason : '正在加载会话历史…'}</p>}{timeline.map(entry => <TimelineEntry key={entry.id} entry={entry} onOpenContext={selected ? () => setInfoPanelOpen(true) : undefined} />)}{selected && <OptimisticMessages controller={submission(selected.id)} confirmedIds={confirmed} />}</div>}</div>
            {selected && <ClusterControls key={`controls:${selected.id}`} api={api} session={selected} activeTurnId={history.activeTurnId} queuedItems={history.queuedItems} pendingApprovals={history.pendingApprovals} enabled={connected && browserOnline && worker?.connectionState === 'online' && history.freshness?.status === 'synced' && !history.error} />}
            {selected && <Composer key={selected.id} controller={submission(selected.id)} session={selected} canSend={canSend} blockedReason={sendBlockedReason} confirmedIds={confirmed} />}
          </div>
          {selected && infoPanelOpen && <SessionInfoPanel session={selected} workspace={workspace} worker={worker} project={project} onClose={() => setInfoPanelOpen(false)} />}
        </div>
      </>}</MainCanvas>
      <InspectorHost open={validSelection && Boolean(projectId) && contextOpen && !['board', 'tasks'].includes(section)} onOpenChange={open => { setContextOpen(open); if (!open && workspaceId) go(`${projectBase}/workspaces`) }}>{!workspace && project && <section className="space-y-3 pb-5"><h2>{project.name}</h2><p className="break-all">项目 ID：{project.id}</p><p>{workspaces.length} 个工作区 · {sessions.length} 个会话</p></section>}{workspace && <section className="space-y-3 pb-5"><h2>{workspace.name}</h2><p>{workspaceStateLabel[workspace.status]}</p><code className="block whitespace-pre-wrap break-all">{workspace.location?.rootPath ?? '等待报告路径'}</code>{workspace.failureReason && <p role="alert">{workspace.failureReason}</p>}<Button disabled={!connected || workspace.status !== 'ready'} onClick={() => openResource('session', workspace.id)}>新建会话</Button></section>}<ContextPanel selected={selected} workspace={workspace} workers={validSelection ? workers.filter(item => item.id === workspace?.workerId) : []} connected={connected} onAddWorker={() => setAddingWorker(true)} /></InspectorHost>
    </div>}
    <Sheet open={navigation} onOpenChange={setNavigation}><SheetContent side="left" className="navigation-sheet p-0"><SheetHeader><SheetTitle>工作台导航</SheetTitle></SheetHeader><div className="border-b border-border p-3 xl:hidden"><label className="relative block"><Search className="absolute left-3 top-3.5 size-4 text-muted-foreground" /><Input aria-label="搜索会话" className="w-full pl-9" placeholder="搜索会话…" value={query} onChange={event => setQuery(event.target.value)} /></label></div><div className="min-h-0 flex-1 overflow-auto">{globalRail}{projectId && projectNavigation}{sidebar}</div></SheetContent></Sheet>

    {addingWorker && <WorkerEnrollmentDialog api={api} workers={workers} onRefreshWorkers={refreshWorkers} onClose={() => { setAddingWorker(false); if (quickSetup) openResource('workspace') }} />}
    {createKind && <CreateDialog key={`${createKind}:${projectId}:${createWorkspaceId}`} kind={createKind} api={api} teamId={config.teamId} projectId={projectId} defaultWorkspaceId={createWorkspaceId} workers={workers} workspaces={workspaces} onClose={() => { setQuickSetup(false); closeCreate() }} onCreated={(kind, id, session) => { closeCreate(); refresh(); if (kind === 'project') go(`/projects/${encodeURIComponent(id)}/sessions`); else if (kind === 'workspace') { if (quickSetup) { setQuickSetup(false); void api.workspaces(projectId).then(items => { const ws = items.find(item => item.id === id); if (ws) quickController().configure(fillQuickChoices({ workspaceId: ws.id, workerId: '', agentKey: '', modelId: '' }, projectId, items, workers)) }).catch(() => { /* Keep the draft; workspace selection remains explicit after refresh. */ }); go(`${projectBase}/sessions`) } else go(`/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(id)}`); } else if (session) go(`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(id)}`) }} />}
  </AppShell></RunLayerContext.Provider>
}
