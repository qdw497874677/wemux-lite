import { ChevronLeft } from 'lucide-react'
import { projectNavigationItems } from './navigation-items.ts'

export function ProjectQuickNav({ base, name, section, go }: { base: string; name: string; section: string; go: (to: string) => void }) {
  const current = section === 'tasks' ? 'board' : section
  return <div className="shrink-0 border-b border-border xl:hidden">
    <div className="flex min-h-11 min-w-0 items-center gap-2 px-3">
      <a href="/projects" onClick={event => { event.preventDefault(); go('/projects') }} className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><ChevronLeft className="size-4" />项目</a>
      <span className="truncate text-sm font-semibold" title={name}>{name}</span>
    </div>
    <nav aria-label="项目快捷导航" className="flex items-center gap-1 overflow-x-auto px-2 pb-2">
      {projectNavigationItems.map(({ path, shortLabel, icon: Icon }) => <a key={path} href={`${base}/${path}`} aria-current={current === path ? 'page' : undefined} className="flex min-h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent aria-[current=page]:bg-accent aria-[current=page]:text-foreground" onClick={event => { event.preventDefault(); go(`${base}/${path}`) }}><Icon className="size-3.5" /><span>{shortLabel}</span></a>)}
    </nav>
  </div>
}
