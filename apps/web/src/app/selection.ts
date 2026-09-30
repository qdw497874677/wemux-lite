export interface Resource { id: string; projectId?: string; workspaceId?: string; canRead?: boolean }
export function resolveSelection(pathname: string, search: string, projects: { id: string }[], workspaces: Resource[], sessions: Resource[]) {
  let parts: string[]
  try { parts = pathname.split('/').filter(Boolean).map(decodeURIComponent) } catch { return { error: '链接编码无效。' } }
  const sections = ['overview', 'canvas', 'board', 'tasks', 'activity', 'connectors', 'skills', 'channels', 'settings', 'workspaces', 'sessions']
  if (parts[0] === 'projects' && parts.length > 2 && (!sections.includes(parts[2]) || parts.length > (['tasks', 'workspaces', 'sessions'].includes(parts[2]) ? 4 : 3))) return { error: '链接不存在。' }
  if (parts[0] && !['projects', 'runtime', 'runtimes', 'cluster', 'settings'].includes(parts[0])) return { error: '链接不存在。' }
  if (parts[0] !== 'projects' && parts.length > 1) return { error: '链接不存在。' }
  const params = new URLSearchParams(search)
  const canonical = parts[0] === 'projects' && Boolean(parts[1])
  let project = canonical ? parts[1] : params.get('project') ?? ''
  const projectRoot = canonical && parts.length === 2
  const session = canonical ? (parts[2] === 'sessions' ? parts[3] : projectRoot || parts[2] === 'canvas' || (parts[2] === 'overview' && params.get('view') === 'canvas') ? params.get('session') ?? '' : '') : params.get('session') ?? ''
  let workspace = canonical ? (parts[2] === 'workspaces' ? parts[3] : projectRoot ? params.get('workspace') ?? '' : '') : params.get('workspace') ?? ''
  if (canonical && (params.has('project') || params.has('session') || params.has('workspace'))) {
    if ((params.has('project') && params.get('project') !== project) || (params.has('session') && params.get('session') !== session) || (params.has('workspace') && params.get('workspace') !== workspace)) return { error: '路径与查询参数冲突。' }
  }
  const selected = session ? sessions.find(item => item.id === session) : undefined
  if (session && (!selected || selected.canRead === false)) return { error: '会话不存在或无权限。' }
  if (selected) {
    if ((project && project !== selected.projectId) || (workspace && workspace !== selected.workspaceId)) return { error: '会话不属于指定项目或工作区。' }
    project = selected.projectId ?? ''; workspace = selected.workspaceId ?? ''
  }
  const ws = workspace ? workspaces.find(item => item.id === workspace) : undefined
  if (workspace && !ws) return { error: '工作区不存在或无权限。' }
  if (ws) {
    if (project && project !== ws.projectId) return { error: '工作区不属于指定项目。' }
    project = ws.projectId ?? ''
  }
  if (project && !projects.some(item => item.id === project)) return { error: '项目不存在或无权限。' }
  if (!canonical && pathname === '/' && project) return { redirect: `/projects/${encodeURIComponent(project)}/${session ? `sessions/${encodeURIComponent(session)}` : workspace ? `workspaces/${encodeURIComponent(workspace)}` : 'overview'}` }
  if (pathname === '/' && !params.size) return { redirect: '/projects' }
  if (projectRoot && params.get('view') === 'canvas') return { redirect: `/projects/${encodeURIComponent(project)}/overview?view=canvas${session ? `&session=${encodeURIComponent(session)}` : ''}` }
  if (projectRoot) return { redirect: `/projects/${encodeURIComponent(project)}/${session ? `sessions/${encodeURIComponent(session)}` : workspace ? `workspaces/${encodeURIComponent(workspace)}` : 'overview'}` }
  return {}
}
