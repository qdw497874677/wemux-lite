import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { DiffLineDTO, FileDiffDTO } from '../../api/dto.ts'
import { cn } from '../../lib/utils.ts'
import { buildDiffRows, MAX_DIFF_LINES } from './diff-model.ts'

export function DiffBlock({ path, diff }: { path: string; diff: FileDiffDTO }) {
  const [expandedFolds, setExpandedFolds] = useState<Set<string>>(() => new Set())
  const additions = diff.lines.filter(line => line.type === 'add').length
  const deletions = diff.lines.filter(line => line.type === 'del').length
  const truncated = diff.lines.length > MAX_DIFF_LINES
  const limited = useMemo(() => diff.lines.slice(0, MAX_DIFF_LINES), [diff.lines])
  const rows = useMemo(() => buildDiffRows(limited, expandedFolds), [limited, expandedFolds])
  return <section className="overflow-hidden rounded-lg border border-border/80 bg-background/60" aria-label={`${path} diff`}>
    <header className="flex min-w-0 items-center gap-3 border-b border-border/80 bg-muted/35 px-3 py-2 text-xs">
      <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={path}>{path}</span>
      <span className="shrink-0 font-mono text-diff-addition-foreground">+{additions}</span>
      <span className="shrink-0 font-mono text-diff-deletion-foreground">-{deletions}</span>
    </header>
    {!diff.supported ? <DiffState>非 git 管理文件，暂不支持 diff</DiffState> : !diff.lines.length ? <DiffState>当前文件没有可显示的 git 差异</DiffState> : <>
      <div className="overflow-x-auto text-[11px] leading-5" role="table" aria-label="行级差异">
        {rows.map(row => row.kind === 'fold'
          ? <FoldRow key={`fold:${row.start}:${row.end}`} count={row.end - row.start} onExpand={() => setExpandedFolds(current => new Set(current).add(`${row.start}:${row.end}`))} />
          : <DiffRow key={`${row.index}:${row.line.type}`} line={row.line} />)}
      </div>
      {truncated && <p role="status" className="border-t border-border/80 bg-warning-surface px-3 py-2 text-xs text-warning-foreground">diff 超过 1000 行，仅显示前 1000 行</p>}
    </>}
  </section>
}

function DiffState({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-border/80 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">{children}</p>
}

function FoldRow({ count, onExpand }: { count: number; onExpand: () => void }) {
  return <button type="button" onClick={onExpand} className="grid min-w-full grid-cols-[3rem_3rem_1fr] border-y border-border/40 bg-muted/30 text-left font-mono text-muted-foreground hover:bg-muted/55" aria-label={`展开 ${count} 行上下文`}>
    <span className="col-span-2 flex items-center justify-center"><ChevronRight className="size-3" /></span><span className="px-2">折叠 {count} 行未变更上下文</span>
  </button>
}

function DiffRow({ line }: { line: DiffLineDTO }) {
  const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
  return <div role="row" className={cn('grid min-w-max grid-cols-[3rem_3rem_1.25rem_minmax(24rem,1fr)] font-mono', line.type === 'add' && 'bg-diff-addition/10 text-diff-addition-foreground', line.type === 'del' && 'bg-diff-deletion/10 text-diff-deletion-foreground')}>
    <span role="cell" className="select-none border-r border-border/35 px-2 text-right text-muted-foreground/60">{line.oldLine ?? ''}</span>
    <span role="cell" className="select-none border-r border-border/35 px-2 text-right text-muted-foreground/60">{line.newLine ?? ''}</span>
    <span role="cell" className="select-none px-1 text-center">{marker}</span>
    <span role="cell" className="whitespace-pre px-2 text-foreground">{line.text || ' '}</span>
  </div>
}

export function DiffFileToggle({ open, children, onClick }: { open: boolean; children: ReactNode; onClick: () => void }) {
  const Icon = open ? ChevronDown : ChevronRight
  return <button type="button" onClick={onClick} className="flex w-full items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1.5 text-left font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground" aria-expanded={open}><Icon className="size-3.5 shrink-0" /><span className="truncate">{children}</span></button>
}
