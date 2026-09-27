import { isExecutable } from '../../lib/capability'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, ChevronsUpDown, CircleCheck, CircleX, FolderGit2, LoaderCircle, Menu, MoreHorizontal, Network, Plus, RefreshCw, Search, Send, Server, ServerCog, Wrench, WifiOff } from 'lucide-react'
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
import { useConfirmDialog } from '../../components/ui/confirm-dialog.tsx'
import { Skeleton } from '../../components/ui/skeleton.tsx'
import { projectNavigationItems } from '../../components/navigation-items.ts'
import { formatChineseTime, formatRelativeTime, runtimeStateLabel, workerStateLabel, workspaceStateLabel } from '../../lib/display'

const runtimeDotClass: Record<SessionDTO['runtimeState'], string> = {
  idle: 'bg-zinc-500',
  queued: 'bg-amber-400',
  running: 'bg-sky-400',
  stopping: 'bg-amber-400',
  unavailable: 'bg-rose-400',
  failed: 'bg-rose-400',
}

const sectionLabelClass = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground'

export function Sidebar({ projects, projectId, section, workspaces, sessions, sessionId, query, loading, projectLoading, connected, onProject, onNavigate, onSession, onCreate, onManageSession }: { projects: ProjectDTO[]; projectId: string; section: string; workspaces: WorkspaceDTO[]; sessions: SessionDTO[]; sessionId: string; query: string; loading: boolean; projectLoading: boolean; connected: boolean; onProject: (id: string) => void; onNavigate: (path: string) => void; onSession: (id: string) => void; onCreate: (kind: CreateKind | 'session', workspaceId?: string) => void; onManageSession: (id: string, patch: { title?: string; archived?: boolean }) => Promise<void> }) {
  const project = projects.find(item => item.id === projectId)
  const normalizedQuery = query.trim().toLowerCase()
  const visibleSessions = sessions
    .filter(item => !normalizedQuery || `${item.title} ${item.agentKey} ${item.modelId ?? ''}`.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const currentSection = section === 'tasks' ? 'board' : section
  const workspaceName = (workspaceId: string) => workspaces.find(item => item.id === workspaceId)?.name ?? workspaceId
  const confirm = useConfirmDialog()
  const [editingSessionId, setEditingSessionId] = useState('')
  const [editingTitle, setEditingTitle] = useState('')
  const finishRename = (session: SessionDTO) => {
    const title = editingTitle.trim()
    setEditingSessionId('')
    if (title && title !== session.title) void onManageSession(session.id, { title })
  }
  return <aside className="flex h-full min-h-0 flex-col border-r border-border bg-card/40">
    <div className="shrink-0 border-b border-border p-2.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm font-medium text-foreground hover:bg-accent" aria-label="切换项目">
            <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate" title={project?.name}>{project?.name ?? (loading ? '正在加载项目…' : '选择项目')}</span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          {projects.map(item => <DropdownMenuItem key={item.id} onSelect={() => onProject(item.id)}><FolderGit2 /><span className="min-w-0 flex-1 truncate">{item.name}</span>{item.id === projectId && <Check className="ml-auto" />}</DropdownMenuItem>)}
          {!projects.length && <DropdownMenuItem disabled>{loading ? '正在加载项目…' : '暂无项目'}</DropdownMenuItem>}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!connected} onSelect={() => onCreate('project')}><Plus />新建项目</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    {projectId && <nav aria-label="项目页面" className="shrink-0 border-b border-border px-2 py-3">
      <p className={cn(sectionLabelClass, 'mb-1.5 px-2')}>导航</p>
      <div className="space-y-0.5">
        {projectNavigationItems.map(({ path, label, icon: Icon }) => <a key={path} href={`/projects/${encodeURIComponent(projectId)}/${path}`} aria-current={currentSection === path ? 'page' : undefined} onClick={event => { event.preventDefault(); onNavigate(path) }} className={cn('flex min-h-9 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground', currentSection === path && 'bg-accent text-foreground')}><Icon className="size-4 shrink-0" /><span className="truncate">{label}</span></a>)}
      </div>
    </nav>}

    <section className="flex min-h-0 flex-1 flex-col" aria-label="最近会话">
      <div className="flex shrink-0 items-center justify-between px-4 pb-1.5 pt-3">
        <p className={sectionLabelClass}>最近会话</p>
        <Button variant="ghost" iconOnly size="icon-xs" className="size-7 rounded-md" aria-label="新建会话" disabled={!connected || !projectId} onClick={() => onCreate('session')}><Plus className="size-3.5" /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {projectLoading ? <div className="space-y-2 px-2 py-3" role="status" aria-label="正在加载会话"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-5/6" /><Skeleton className="h-12 w-full" /></div> : visibleSessions.map(session => {
          const fullDetails = `${session.title}\n工作区：${workspaceName(session.workspaceId)}\n智能体 / 模型：${session.agentKey} / ${session.modelId || '默认模型'}\n状态：${runtimeStateLabel[session.runtimeState]}\n更新：${formatChineseTime(session.updatedAt)}`
          return <div key={session.id} className="group flex items-center gap-1">
            <button type="button" title={fullDetails} aria-current={session.id === sessionId ? 'true' : undefined} className={cn('min-w-0 flex-1 rounded-md px-2.5 py-2 text-left text-muted-foreground hover:bg-accent hover:text-foreground', session.id === sessionId && 'bg-accent text-foreground')} onClick={() => onSession(session.id)}>
              {editingSessionId === session.id ? <Input autoFocus aria-label="会话标题" className="h-7 px-2 text-sm" value={editingTitle} onClick={event => event.stopPropagation()} onChange={event => setEditingTitle(event.target.value)} onBlur={() => finishRename(session)} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') finishRename(session); if (event.key === 'Escape') setEditingSessionId('') }} /> : <span className="block truncate text-sm font-medium" onDoubleClick={event => { event.stopPropagation(); setEditingSessionId(session.id); setEditingTitle(session.title) }}>{session.title}</span>}
              <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className={cn('size-1.5 shrink-0 rounded-full', runtimeDotClass[session.runtimeState])} aria-label={runtimeStateLabel[session.runtimeState]} role="img" /><span>{formatRelativeTime(session.updatedAt)}</span></span>
            </button>
            <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" iconOnly size="icon-xs" className="size-7 shrink-0 rounded-md opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={`会话操作 ${session.title}`}><MoreHorizontal className="size-3.5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => { setEditingSessionId(session.id); setEditingTitle(session.title) }}>重命名</DropdownMenuItem><DropdownMenuItem onSelect={() => { void confirm({ title: '归档会话', description: `归档会话「${session.title}」？归档后将不再显示在会话列表中。`, confirmLabel: '归档', danger: true }).then(confirmed => { if (confirmed) void onManageSession(session.id, { archived: true }) }) }}>归档</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
          </div>
        })}
        {!projectLoading && !visibleSessions.length && <p className="px-2 py-3 text-xs leading-5 text-muted-foreground">{normalizedQuery ? '没有匹配的会话' : projectId ? '暂无会话，从上方开始新对话。' : connected ? '请先选择项目。' : '连接服务端后显示会话。'}</p>}
      </div>
    </section>
  </aside>
}

export function ContextPanel({ selected, workspace, workers, connected, onAddWorker, onOpenCluster }: { selected?: SessionDTO; workspace?: WorkspaceDTO; workers: WorkerDTO[]; connected: boolean; onAddWorker: () => void; onOpenCluster: () => void }) {
  return <><div className="mb-4 flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">会话与工作节点</h2><Button variant="ghost" size="icon" aria-label="添加工作节点" disabled={!connected} onClick={onAddWorker}><Plus className="size-4" /></Button></div>{selected && <section className="mb-3 space-y-3 rounded-xl border border-border bg-card p-3 text-sm"><Badge variant="outline">固定执行环境</Badge><p>{selected.agentKey} / {selected.modelId}</p><p className="text-muted-foreground">工作区：{workspace?.name ?? selected.workspaceId} · {workspace ? workspaceStateLabel[workspace.status] : '状态未知'}</p><code className="block break-all text-xs text-muted-foreground">{workspace?.location?.rootPath ?? '工作节点尚未报告路径'}</code><p className="text-xs leading-5 text-muted-foreground">会话不会自动迁移到其他工作节点或切换模型。聊天与工具输出可能包含敏感信息。</p></section>}{workers.map(item => <section key={item.id} className="mb-3 rounded-xl border border-border bg-background/50 p-3"><div className="flex items-center gap-2"><Server className="size-4 text-muted-foreground" /><strong className="min-w-0 flex-1 truncate text-sm">{item.name}</strong><Badge variant={item.connectionState === 'online' ? 'success' : item.connectionState === 'revoked' ? 'danger' : 'warning'}>{workerStateLabel[item.connectionState]}</Badge></div><p className="mt-2 text-xs text-muted-foreground">最后在线：{item.lastSeenAt ? formatChineseTime(item.lastSeenAt) : '未知'}</p><p className="mt-2 text-xs text-muted-foreground">{item.capabilities.filter(agent => isExecutable(agent)).length} 个可用智能体</p><button type="button" className="mt-3 text-xs text-violet-200 hover:underline" onClick={onOpenCluster}>查看集群详情</button></section>)}</>
}
