import { MessageSquare, ChevronRight } from 'lucide-react'
import type { SessionDTO, WorkspaceDTO, WorkerDTO } from '../api/dto'
import { runtimeStateLabel, formatChineseTime } from '../lib/display'

/** A project-wide conversation index, not a workspace tree. */
export function ProjectSessionList({ base, sessions, workspaces, workers, go }: { base: string; sessions: SessionDTO[]; workspaces: WorkspaceDTO[]; workers: WorkerDTO[]; go: (to: string) => void }) {
  const readable = sessions.filter(session => session.canRead).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return <section aria-label="项目会话列表" className="divide-y divide-border">
    {!readable.length && <p className="py-8 text-sm text-muted-foreground">暂无可读会话。在上方输入首条消息，确认工作区、智能体和模型后开始对话。</p>}
    {readable.map(session => <a key={session.id} href={`${base}/sessions/${encodeURIComponent(session.id)}`} onClick={event => { event.preventDefault(); go(`${base}/sessions/${encodeURIComponent(session.id)}`) }} className="flex items-start gap-3 rounded-md px-2 py-4 hover:bg-accent/50">
      <MessageSquare className="mt-1 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-3 gap-y-1"><h2 className="min-w-0 break-words text-sm font-medium">{session.title}</h2><span className="text-xs text-muted-foreground">{runtimeStateLabel[session.runtimeState]}</span></div>
        <p className="mt-2 break-words text-xs text-muted-foreground">工作区：{workspaces.find(ws => ws.id === session.workspaceId)?.name ?? session.workspaceId} · 节点：{workers.find(worker => worker.id === session.workerId)?.name ?? session.workerId}</p>
        <p className="mt-1 break-all text-xs text-muted-foreground">{session.agentKey} · {session.modelId}</p>
        <p className="mt-1 text-xs text-muted-foreground">{Number.isFinite(Date.parse(session.updatedAt)) ? `更新于 ${formatChineseTime(session.updatedAt)}` : '更新时间暂不可用'}</p>
      </div><ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
    </a>)}
  </section>
}
