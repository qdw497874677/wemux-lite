import { ChevronLeft, MoreHorizontal } from 'lucide-react'
import { Button } from './ui/button.tsx'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu.tsx'

export function ProjectQuickNav({ base, name, section, go }: { base: string; name: string; section: string; go: (to: string) => void }) {
  const current = section === 'tasks' ? 'board' : section
  return <div className="shrink-0 border-b border-border xl:hidden">
    <div className="flex min-h-11 min-w-0 items-center gap-2 px-3">
      <a href="/projects" onClick={event => { event.preventDefault(); go('/projects') }} className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><ChevronLeft className="size-4" />项目</a>
      <span className="truncate text-sm font-semibold" title={name}>{name}</span>
    </div>
    <nav aria-label="项目快捷导航" className="flex items-center gap-1 px-2 pb-2">
      {[['sessions', '对话'], ['workspaces', '工作区'], ['board', '任务']].map(([path, label]) => <a key={path} href={`${base}/${path}`} aria-current={current === path ? 'page' : undefined} className="flex min-h-11 flex-1 items-center justify-center whitespace-nowrap rounded-md px-2 text-sm text-muted-foreground hover:bg-accent aria-[current=page]:text-foreground" onClick={event => { event.preventDefault(); go(`${base}/${path}`) }}>{label}</a>)}
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" className="min-h-11 px-2" aria-label="更多项目页面"><MoreHorizontal className="size-4" /><span className="text-xs">{current === 'activity' ? '活动' : current === 'settings' ? '设置' : '更多'}</span></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => go(`${base}/overview`)}>项目概览</DropdownMenuItem><DropdownMenuItem onSelect={() => go(`${base}/activity`)}>项目活动</DropdownMenuItem><DropdownMenuItem onSelect={() => go(`${base}/settings`)}>项目设置</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    </nav>
  </div>
}
