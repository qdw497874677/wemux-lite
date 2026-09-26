import { Bot, Cpu, ExternalLink, FolderGit2, HardDrive, Server, Wifi } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { runtimeStateLabel } from '../../lib/display.ts'
import type { ProjectDTO, RuntimeState, SessionDTO, WorkerDTO, WorkspaceDTO } from '../../api/dto.ts'
import type { ReturnTypeOfCreateApi } from '../../api/team-types.ts'
import { SessionAccessPanel } from '../../components/session-access.tsx'

const freshnessLabels: Record<string, string> = { unknown: '历史完整性尚未确认', syncing: '正在补传历史', synced: '历史已同步', gap: '历史存在事件缺口', offline: '工作节点离线，仅展示缓存', orphaned: '工作节点已丢失，仅可读取缓存' }
const runtimeStateDot: Record<RuntimeState, string> = { idle: 'bg-muted-foreground/40', queued: 'bg-amber-400', running: 'bg-emerald-400 animate-pulse-dot', stopping: 'bg-amber-400', unavailable: 'bg-red-400', failed: 'bg-red-400' }

export interface SessionInfoPanelProps { api: ReturnTypeOfCreateApi; session: SessionDTO; workspace?: WorkspaceDTO; worker?: WorkerDTO; project?: ProjectDTO; onChanged: () => void }
function Row({ icon: Icon, label, children, mono }: { icon: React.ComponentType<{ className?: string }>; label: string; children: React.ReactNode; mono?: boolean }) { return <div className="flex items-start gap-2.5 py-1.5"><Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" /><div className="min-w-0 flex-1"><div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">{label}</div><div className={cn('mt-0.5 truncate text-xs text-foreground/90', mono && 'font-mono text-[11px]')}>{children}</div></div></div> }
function Section({ title, children }: { title: string; children: React.ReactNode }) { return <div className="border-b border-border/30 px-3.5 py-2.5 last:border-b-0"><div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">{title}</div>{children}</div> }

export function SessionInfoPanel({ api, session, workspace, worker, project, onChanged }: SessionInfoPanelProps) {
  const freshness = session.freshness?.status ?? 'unknown'
  return <div className="h-full overflow-y-auto">
    <Section title="会话"><div className="mb-2 truncate text-sm font-medium text-foreground" title={session.title}>{session.title}</div><div className="flex items-center gap-1.5"><span className={cn('inline-flex size-1.5 rounded-full', runtimeStateDot[session.runtimeState] ?? 'bg-muted-foreground/40')} /><span className="text-xs font-medium text-foreground/80">{runtimeStateLabel[session.runtimeState] ?? session.runtimeState}</span></div><div className="mt-1.5 text-[10px] text-muted-foreground/60">{freshnessLabels[freshness] ?? freshness}</div>{session.queuedMessageCount ? <div className="mt-1 text-[10px] text-amber-300/80">{session.queuedMessageCount} 条消息排队中</div> : null}</Section>
    <Section title="运行时"><Row icon={Bot} label="Agent" mono>{session.agentKey}</Row><Row icon={Cpu} label="模型" mono>{session.modelId}</Row>{worker ? <Row icon={Server} label="Worker"><span className="inline-flex items-center gap-1.5">{worker.name}<span className={cn('inline-flex size-1.5 rounded-full', worker.connectionState === 'online' ? 'bg-emerald-400' : worker.connectionState === 'offline' ? 'bg-muted-foreground/40' : 'bg-red-400')} /><span className="text-[10px] text-muted-foreground/50">{worker.connectionState === 'online' ? '在线' : worker.connectionState === 'offline' ? '离线' : '已吊销'}</span></span></Row> : <Row icon={Server} label="Worker" mono>{session.workerId.slice(0, 12)}…</Row>}</Section>
    {workspace && <Section title="工作区"><Row icon={FolderGit2} label="名称">{workspace.name}</Row>{workspace.location?.rootPath && <Row icon={HardDrive} label="路径" mono><span className="break-all text-[10px] leading-relaxed" title={workspace.location.rootPath}>{workspace.location.rootPath}</span></Row>}{workspace.repository?.kind === 'git' && <Row icon={ExternalLink} label="仓库" mono><a href={workspace.repository.url} target="_blank" rel="noopener noreferrer" className="truncate text-primary/80 hover:underline">{workspace.repository.url}</a></Row>}</Section>}
    {project && <Section title="项目"><Row icon={FolderGit2} label="名称">{project.name}</Row></Section>}
    {project && <Section title="共享与权限"><SessionAccessPanel api={api} session={session} project={project} onChanged={onChanged} /></Section>}
    <Section title="标识"><div className="space-y-1">{[['Session', session.id], ['Workspace', session.workspaceId], ['Worker', session.workerId]].map(([label, value]) => <div key={label} className="flex items-center justify-between"><span className="text-[10px] text-muted-foreground/40">{label}</span><span className="font-mono text-[9px] text-muted-foreground/40">{value.slice(0, 8)}</span></div>)}</div></Section>
    <div className="px-3.5 py-3"><div className="flex items-start gap-2 rounded-lg border border-border/30 bg-muted/20 px-2.5 py-2"><Wifi className="mt-0.5 size-3 shrink-0 text-muted-foreground/40" /><p className="text-[10px] leading-relaxed text-muted-foreground/50">此会话绑定固定 Worker、Workspace、Agent 与模型。切换需新建会话。</p></div></div>
  </div>
}
