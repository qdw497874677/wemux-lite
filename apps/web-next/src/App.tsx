import { ProjectCreate, ProjectManagement } from './components/ProjectManagement.tsx'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { FolderKanban, Network } from 'lucide-react'
import { createApplication, resolveRoute, safeReturnTarget, type Application } from './application.ts'
import { navigate, useLocation } from './lib/navigation.ts'
import { Login } from './components/Login.tsx'
import { Failure } from './components/Failure.tsx'
import { EmptyState } from './components/primitives.tsx'
import { ProjectList, ProjectSummary } from './components/Projects.tsx'
import { AccountLink } from './components/PublicAccount.tsx'
import { AccountSecurity } from './components/AccountSecurity.tsx'
import { AccountCredentials } from './components/AccountCredentials.tsx'
import { AccountGovernance } from './components/AccountGovernance.tsx'
import { Teams, JoinTeam } from './components/Teams.tsx'
import { Shell } from './components/Shell.tsx'
import { Attention } from './components/Attention.tsx'

export const application = createApplication()
export function App({ app = application }: { app?: Application }) {
  const state = useSyncExternalStore(app.subscribe, app.getSnapshot)
  const location = useLocation()
  const route = resolveRoute(location.path)
  useEffect(() => { void app.start(); return app.dispose }, [app])
  useEffect(() => {
    if (state.phase !== 'ready') return
    if (route.kind === 'login') navigate(safeReturnTarget(new URLSearchParams(location.search).get('returnTo')), true)
    else if (location.path === '/next/') navigate(`/next/projects${location.search}${location.hash}`, true)
  }, [state.phase, location.path, location.search, location.hash, route.kind])
  useEffect(() => {
    if (state.phase !== 'ready') return
    const refresh = () => { void app.revalidateAccess() }
    const visible = () => { if (document.visibilityState === 'visible') refresh() }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', visible)
    const timer = window.setInterval(refresh, 15000)
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visible); window.clearInterval(timer) }
  }, [app, state.phase, location.path])
  if (state.phase === 'loading') return <main className="recovery" role="status">正在连接当前宿主…</main>
  if (state.phase === 'error') return <main className="recovery">{state.error && <Failure error={state.error} retry={() => void app.start()} />}<a href="/">返回旧版控制台</a></main>
  if (state.phase === 'local-worker') return <main className="recovery"><EmptyState icon={Network} title="当前是独立 Worker" message="新版尚未迁移本地任务与会话。请使用本机工作台；此入口不会使用集群账号登录，也不会上传本地会话。" /><a className="button button-default" href="/local">打开本机工作台</a></main>
  if (route.kind === 'auth-link') return <AccountLink key={location.path + location.search} app={app} path={location.path} search={location.search} />
  if (state.phase === 'login') return <Login key={location.key} app={app} state={state} />
  const api = app.getClient()!
  const project = route.kind === 'project' ? state.projects.find(item => item.id === route.projectId) : undefined
  const projectList = <><ProjectList projects={state.projects} loading={state.busy} />{state.account?.instanceAdministrator && <ProjectCreate api={api} teamId={state.account.teamId} reload={app.loadProjects} />}</>
  const accountPage = route.kind === 'settings' ? <><h1>账号设置</h1><AccountSecurity api={api} restart={app.start} /><AccountCredentials api={api} /><AccountGovernance api={api} administrator={state.account!.instanceAdministrator} restart={app.start} /></> : route.kind === 'teams' ? <Teams api={api} app={app} /> : route.kind === 'join' ? <JoinTeam api={api} app={app} token={new URLSearchParams(location.search).get('token') ?? ''} /> : null
  return <Shell key={`${state.account?.username}:${state.account?.teamId}`} state={state} app={app} location={location}>
    {accountPage && state.error && <Failure error={state.error} retry={() => void app.loadProjects()} />}
    {accountPage ?? (state.error ? <Failure error={state.error} retry={() => void app.loadProjects()} /> : route.kind === 'projects' ? projectList : route.kind === 'attention' ? <Attention api={api} projects={state.projects} busy={state.busy} administrator={state.account!.instanceAdministrator} /> : route.kind === 'not-found' ? <EmptyState icon={FolderKanban} title="页面不存在" message="此地址没有对应的新版页面。请检查链接，或返回项目列表。" action="返回项目列表" onAction={() => navigate('/next/projects')} /> : route.kind === 'project' ? <ProjectPage search={location.search} key={route.projectId} project={project} busy={state.busy} api={api} administrator={state.account!.instanceAdministrator} reload={app.loadProjects} /> : <ProjectList projects={state.projects} />)}
  </Shell>
}

/** Keep editor DOM during permission rechecks, but hide/inert it until access is confirmed.
 * Revocation retires the subtree; no stale names or counts remain visible while pending. */
function ProjectPage({ project, busy, ...props }: { project: import('@wemux/web-contract/browser-host').ProjectDTO | undefined; busy: boolean } & Omit<Parameters<typeof ProjectManagement>[0], 'project'>) {
  const confirmed = useRef(project)
  if (!busy) confirmed.current = project
  const display = busy ? confirmed.current : project
  return <>{busy && <p role="status">正在核验项目权限…</p>}<div hidden={busy} inert={busy}><ProjectSummary project={display} />{display && <ProjectManagement key={display.accessRole} {...props} project={display} />}</div></>
}
