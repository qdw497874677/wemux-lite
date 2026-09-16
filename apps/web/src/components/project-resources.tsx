import { ChevronRight, FolderGit2, MessageSquare } from 'lucide-react'
import type { SessionDTO, WorkerDTO, WorkspaceDTO } from '../api/dto'
import { runtimeStateLabel, workspaceStateLabel } from '../lib/display'

export function ProjectResources({ base, workspaces, sessions, workers, go }: { base: string; workspaces: WorkspaceDTO[]; sessions: SessionDTO[]; workers: WorkerDTO[]; go: (to: string) => void }) {
  const recent = sessions.filter(item => item.canRead).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5)
  const link = (path: string) => ({ href: `${base}/${path}`, onClick: (event: React.MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); go(`${base}/${path}`) } })
  return <div className="grid gap-6 lg:grid-cols-2">
    <section aria-label="工作区快捷入口" className="min-w-0">
      <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">工作区 <span className="ml-1 text-xs font-normal text-muted-foreground">{workspaces.length}</span></h2><a {...link('workspaces')} className="inline-flex min-h-11 items-center text-xs text-muted-foreground underline underline-offset-4">查看全部</a></div>
      <div className="divide-y divide-border rounded-lg border border-border">
        {workspaces.slice(0, 5).map(ws => <a key={ws.id} {...link(`workspaces/${encodeURIComponent(ws.id)}`)} className="flex min-h-20 items-center gap-3 px-3 py-3 hover:bg-accent/50"><FolderGit2 className="size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{ws.name}</p><p className="mt-1 truncate text-xs text-muted-foreground">{workspaceStateLabel[ws.status]} · {workers.find(w => w.id === ws.workerId)?.name ?? ws.workerId}</p></div><ChevronRight className="size-4 shrink-0 text-muted-foreground" /></a>)}
        {!workspaces.length && <p className="px-4 py-6 text-sm text-muted-foreground">还没有工作区，点击上方“新建工作区”开始。</p>}
      </div>
    </section>
    <section aria-label="最近会话" className="min-w-0">
      <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">最近会话</h2><a {...link('sessions')} className="inline-flex min-h-11 items-center text-xs text-muted-foreground underline underline-offset-4">查看全部</a></div>
      <div className="divide-y divide-border rounded-lg border border-border">
        {recent.map(session => <a key={session.id} {...link(`sessions/${encodeURIComponent(session.id)}`)} className="flex min-h-20 items-center gap-3 px-3 py-3 hover:bg-accent/50"><MessageSquare className="size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{session.title}</p><p className="mt-1 truncate text-xs text-muted-foreground">{workspaces.find(ws => ws.id === session.workspaceId)?.name ?? session.workspaceId} · {runtimeStateLabel[session.runtimeState]}</p></div><ChevronRight className="size-4 shrink-0 text-muted-foreground" /></a>)}
        {!recent.length && <p className="px-4 py-6 text-sm text-muted-foreground">暂无可读会话，进入已就绪的工作区开始对话。</p>}
      </div>
    </section>
  </div>
}
