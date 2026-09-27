import { ChevronRight, File, Folder, FolderOpen } from 'lucide-react'
import type { FileEntryDTO } from '../../api/dto.ts'
import { cn } from '../../lib/utils.ts'

export interface FileTreeState {
  readonly entries: ReadonlyMap<string, readonly FileEntryDTO[]>
  readonly expanded: ReadonlySet<string>
  readonly loading: ReadonlySet<string>
}

const childPath = (parent: string, name: string) => parent ? `${parent}/${name}` : name

export function FileTree({ state, selectedPath, onToggle, onSelect }: {
  state: FileTreeState
  selectedPath: string
  onToggle: (path: string) => void
  onSelect: (path: string) => void
}) {
  const render = (parent: string, depth: number) => (state.entries.get(parent) ?? []).map(entry => {
    const path = childPath(parent, entry.name), directory = entry.type === 'directory', expanded = state.expanded.has(path)
    return <div key={path}>
      <button type="button" className={cn('flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-muted', selectedPath === path && 'bg-accent text-accent-foreground')} style={{ paddingLeft: `${depth * 14 + 8}px` }} onClick={() => directory ? onToggle(path) : onSelect(path)}>
        {directory ? <ChevronRight className={cn('size-3 shrink-0 transition-transform', expanded && 'rotate-90')} /> : <span className="w-3" />}
        {directory ? expanded ? <FolderOpen className="size-4 shrink-0 text-sky-400" /> : <Folder className="size-4 shrink-0 text-sky-400" /> : <File className="size-4 shrink-0 text-muted-foreground" />}
        <span className="truncate">{entry.name}</span>
      </button>
      {directory && expanded && <div>{state.loading.has(path) && <p className="py-1 text-xs text-muted-foreground" style={{ paddingLeft: `${(depth + 1) * 14 + 28}px` }}>正在加载…</p>}{render(path, depth + 1)}</div>}
    </div>
  })
  return <div role="tree" aria-label="文件树" className="py-1">{state.loading.has('') && !(state.entries.get('')?.length) ? <p className="p-3 text-xs text-muted-foreground">正在加载文件…</p> : render('', 0)}</div>
}
