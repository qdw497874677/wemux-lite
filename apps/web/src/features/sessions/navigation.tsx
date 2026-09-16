import { isExecutable, capabilityLabel } from '../../lib/capability'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, CircleCheck, CircleX, FolderGit2, LoaderCircle, Menu, MessageSquarePlus, MoreHorizontal, Network, Plus, RefreshCw, Search, Send, Server, ServerCog, Settings2, Wrench, WifiOff } from 'lucide-react'
import { ApiError, createApi, type ConnectionConfig } from '../../api/client'
import { clearConnectionConfig, readConnectionConfig, saveConnectionConfig } from '../../lib/connection-storage'
import type { ProjectDTO, SendMessageDTO, SessionDTO, WorkerDTO, WorkspaceDTO } from '../../api/dto'
import { useSession } from '../../api/use-session'
import type { ChatMessage, ChatTimelineItem, TimelineTool } from '../../api/journal'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Input } from '../../components/ui/input'
import { Textarea } from '../../components/ui/textarea'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../../components/ui/sheet'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../../components/ui/dropdown-menu'
import { ConnectionDialog } from '../../components/connection-dialog'
import { CreateDialog, type CreateKind } from '../../components/create-dialog'
import { WorkerEnrollmentDialog } from '../../components/worker-enrollment-dialog'
import { ClusterPage } from '../../components/cluster-page'
import { cn } from '../../lib/utils'
import { formatChineseTime, runtimeStateLabel, workerStateLabel, workspaceStateLabel } from '../../lib/display'

export function Sidebar({ projects, projectId, workspaces, workers, sessions, sessionId, query, loading, projectLoading, connected, onQuery, onProject, onSession, onCreate }: { projects: ProjectDTO[]; projectId: string; workspaces: WorkspaceDTO[]; workers: WorkerDTO[]; sessions: SessionDTO[]; sessionId: string; query: string; loading: boolean; projectLoading: boolean; connected: boolean; onQuery: (value: string) => void; onProject: (id: string) => void; onSession: (id: string) => void; onCreate: (kind: CreateKind, workspaceId?: string) => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const normalizedQuery = query.trim().toLowerCase()
  const selectedWorkspaceId = sessions.find(item => item.id === sessionId)?.workspaceId
  useEffect(() => {
    if (selectedWorkspaceId) setCollapsed(current => current[selectedWorkspaceId] ? { ...current, [selectedWorkspaceId]: false } : current)
  }, [selectedWorkspaceId])
  return <aside className="flex h-full min-h-0 flex-col border-r border-border bg-card/40">
    <div className="flex min-h-12 shrink-0 items-center justify-between border-b border-border px-3"><strong className="text-sm">项目资源</strong><Button variant="ghost" size="icon" aria-label="新建项目" disabled={!connected} onClick={() => onCreate('project')}><Plus className="size-4" /></Button></div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="space-y-1">{projects.map(project => <button key={project.id} aria-current={project.id === projectId ? 'true' : undefined} onClick={() => onProject(project.id)} className={cn('flex min-h-10 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent', project.id === projectId && 'bg-accent text-foreground ring-1 ring-border')}><FolderGit2 className="size-4 shrink-0" /><span title={project.name} className="min-w-0 flex-1 truncate">{project.name}</span>{project.id === projectId && <ChevronDown className="size-3.5 shrink-0" />}</button>)}{!projects.length && <p className="p-2 text-sm text-muted-foreground">{loading ? '正在加载项目…' : connected ? '暂无项目，请先新建项目。' : '连接服务端后显示项目。'}</p>}</div>
      {projectId && <section className="ml-4 mt-2 border-l border-border pl-2" aria-label="当前项目资源树">
        <div className="mb-2 flex min-h-9 items-center justify-between pl-2"><span className="text-[11px] text-muted-foreground">Workspace</span><div className="flex items-center"><Button variant="ghost" size="icon" aria-label="" disabled={!connected} onClick={() => onCreate('session')}><MessageSquarePlus className="size-4" /></Button><Button variant="ghost" size="icon" aria-label="" disabled={!connected} onClick={() => onCreate('workspace')}><Plus className="size-4" /></Button></div></div>
        {projectLoading ? <p className="px-2 py-3 text-sm text-muted-foreground">正在加载 Workspace…</p> : workspaces.map(workspace => {
          const worker = workers.find(item => item.id === workspace.workerId)
          const workspaceMatches = `${workspace.name} ${worker?.name ?? workspace.workerId}`.toLowerCase().includes(normalizedQuery)
          const workspaceSessions = sessions.filter(item => item.workspaceId === workspace.id && (!normalizedQuery || workspaceMatches || `${item.title} ${item.agentKey} ${item.modelId}`.toLowerCase().includes(normalizedQuery)))
          const isCollapsed = collapsed[workspace.id] ?? false
          if (normalizedQuery && !workspaceMatches && !workspaceSessions.length) return null
          return <div key={workspace.id} className="mb-2 overflow-hidden rounded-lg border border-border bg-background/35">
            <button className="flex min-h-10 w-full items-center gap-2 px-2.5 py-2 text-left" aria-expanded={!isCollapsed} onClick={() => setCollapsed(current => ({ ...current, [workspace.id]: !isCollapsed }))}>{isCollapsed ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}<span className="min-w-0 flex-1 truncate text-sm font-medium">{workspace.name}</span><Badge variant={workspace.status === 'ready' ? 'success' : workspace.status === 'failed' ? 'danger' : 'warning'}>{workspaceStateLabel[workspace.status]}</Badge></button>
            {!isCollapsed && <div className="ml-4 border-l border-border pb-2 pl-2">
              <div className="flex min-h-8 items-center justify-between pr-1"><span className="text-[11px] text-muted-foreground">Session 对话</span><Button variant="ghost" size="icon" className="size-7" aria-label={`在 ${workspace.name} 新建会话`} disabled={!connected || workspace.status !== 'ready' || worker?.connectionState !== 'online'} onClick={() => onCreate('session', workspace.id)}><MessageSquarePlus className="size-3.5" /></Button></div>
              {workspaceSessions.map(session => <button key={session.id} aria-current={session.id === sessionId ? 'true' : undefined} className={cn('mb-1 min-h-10 w-full rounded-md border border-transparent px-2 py-2 text-left text-xs hover:bg-accent', session.id === sessionId && 'border-indigo-500/20 bg-indigo-500/10')} onClick={() => onSession(session.id)}><span title={session.title} className="block truncate font-medium">{session.title}</span><small className="mt-1 block truncate text-[10px] text-muted-foreground">{session.agentKey} · {session.modelId} · {runtimeStateLabel[session.runtimeState]}</small></button>)}
              {!workspaceSessions.length && <p className="px-2 py-2 text-xs text-muted-foreground">{normalizedQuery ? '没有匹配的会话' : '尚未创建会话'}</p>}
            </div>}
            <div className="flex min-h-8 items-center gap-2 border-t border-border bg-card/40 px-3 text-[10px] text-muted-foreground"><Server className="size-3 shrink-0" /><span className="shrink-0">执行节点</span><span className="min-w-0 flex-1 truncate text-foreground/80">{worker?.name ?? workspace.workerId}</span><span className={cn('size-2 rounded-full', worker?.connectionState === 'online' ? 'bg-emerald-400' : worker?.connectionState === 'revoked' ? 'bg-red-400' : 'bg-amber-400')} role="img" aria-label={worker ? workerStateLabel[worker.connectionState] : '节点未知'} /></div>
            {workspace.failureReason && <p className="border-t border-border px-3 py-2 text-xs text-red-300">{workspace.failureReason}</p>}
          </div>
        })}
        {!projectLoading && !workspaces.length && <p className="px-2 py-3 text-sm text-muted-foreground">当前项目暂无 Workspace</p>}
        {query && <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => onQuery('')}>清除搜索</Button>}
      </section>}
    </div>
  </aside>
}

export function ContextPanel({ selected, workspace, workers, connected, onAddWorker }: { selected?: SessionDTO; workspace?: WorkspaceDTO; workers: WorkerDTO[]; connected: boolean; onAddWorker: () => void }) {
  return <><div className="mb-4 flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">会话与工作节点</h2><Button variant="ghost" size="icon" aria-label="添加工作节点" disabled={!connected} onClick={onAddWorker}><Plus className="size-4" /></Button></div>{selected && <section className="mb-3 space-y-3 rounded-xl border border-border bg-card p-3 text-sm"><Badge variant="outline">固定执行环境</Badge><p>{selected.agentKey} / {selected.modelId}</p><p className="text-muted-foreground">工作区：{workspace?.name ?? selected.workspaceId} · {workspace ? workspaceStateLabel[workspace.status] : '状态未知'}</p><code className="block break-all text-xs text-muted-foreground">{workspace?.location?.rootPath ?? '工作节点尚未报告路径'}</code><p className="text-xs leading-5 text-muted-foreground">会话不会自动迁移到其他工作节点或切换模型。聊天与工具输出可能包含敏感信息。</p></section>}{workers.map(item => <section key={item.id} className="mb-3 rounded-xl border border-border bg-background/50 p-3"><div className="flex items-center gap-2"><Server className="size-4 text-muted-foreground" /><strong className="min-w-0 flex-1 truncate text-sm">{item.name}</strong><Badge variant={item.connectionState === 'online' ? 'success' : item.connectionState === 'revoked' ? 'danger' : 'warning'}>{workerStateLabel[item.connectionState]}</Badge></div><p className="mt-2 text-xs text-muted-foreground">最后在线：{item.lastSeenAt ? formatChineseTime(item.lastSeenAt) : '未知'}</p><p className="mt-2 text-xs text-muted-foreground">{item.capabilities.filter(agent => isExecutable(agent)).length} 个可用智能体 · {item.capabilities.reduce((sum, agent) => sum + agent.models.length, 0)} 个模型</p><details className="mt-3 text-xs"><summary className="cursor-pointer text-violet-200">查看智能体与模型</summary>{item.capabilities.map(agent => <div key={agent.agentKey} className="mt-3 border-t border-border pt-2"><b>{agent.displayName}</b><p className="mt-1 text-muted-foreground">{agent.availability.status === 'available' ? '可用' : agent.availability.status === 'authentication-required' ? '需要认证' : '不可用'}</p>{agent.availability.reason && <p className="text-amber-200">{agent.availability.reason}</p>}<div className="mt-2 flex flex-wrap gap-1">{agent.models.map(model => <Badge key={model.modelId} variant="outline">{model.displayName}</Badge>)}</div></div>)}</details></section>)}</>
}
