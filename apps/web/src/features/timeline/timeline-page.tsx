import { useCallback, useMemo, useState } from 'react'
import { Filter, RefreshCw } from 'lucide-react'
import type { ProjectDTO } from '../../api/dto.ts'
import { Button } from '../../components/ui/button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select.tsx'
import { fetchTimeline } from '../projections/projection-client.ts'
import { FreshnessBadge, ProjectionEmpty, ProjectionSkeleton } from '../projections/projection-ui.tsx'
import { useProjectionPage } from '../projections/use-projection-page.ts'
import { groupByKey } from '../projections/group.ts'
import type { ProjectionFilters } from '../projections/projection-model.ts'

const sourceLabels = { audit: '审计', task_activity: 'Task 活动', run: 'Run', channel_delivery: 'Channel 投递', session: 'Session' } as const

export function TimelinePage({ projects, initialProjectId }: { readonly projects: readonly ProjectDTO[]; readonly initialProjectId?: string }) {
  const [filters, setFilters] = useState<ProjectionFilters>({ projectId: initialProjectId })
  const dependencyKey = JSON.stringify(filters)
  const load = useCallback((cursor?: string) => fetchTimeline(filters, cursor), [dependencyKey])
  const page = useProjectionPage(load, dependencyKey)
  const grouped = useMemo(() => groupByKey(page.items, item => new Date(item.occurredAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })), [page.items])

  return <section className="mx-auto max-w-6xl p-4 md:p-6">
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">统一只读投影</p><h1 className="mt-1 text-2xl font-bold">时间线</h1><p className="mt-1 text-sm text-muted-foreground">按发生时间汇总项目活动与审计事件。</p></div>
      <Button variant="outline" onClick={() => void page.refresh()}><RefreshCw size={14} />刷新</Button>
    </header>

    <section aria-labelledby="timeline-filter-title" className="mb-7 rounded-xl border border-border/80 bg-card/60 p-4 shadow-sm">
      <div className="mb-4 flex items-start gap-2.5 border-b border-border/70 pb-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border/70 bg-muted/50 text-muted-foreground"><Filter size={15} /></span>
        <div><h2 id="timeline-filter-title" className="text-sm font-semibold">筛选事件</h2><p className="mt-0.5 text-xs text-muted-foreground">按项目和事件来源查看相关活动。</p></div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">项目</span><Select value={filters.projectId ?? 'all'} onValueChange={value => setFilters(current => ({ ...current, projectId: value === 'all' ? undefined : value }))}><SelectTrigger aria-label="筛选项目"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部项目</SelectItem>{projects.map(project => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent></Select></label>
        <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">来源</span><Select value={filters.sourceKind ?? 'all'} onValueChange={value => setFilters(current => ({ ...current, sourceKind: value === 'all' ? undefined : value }))}><SelectTrigger aria-label="筛选事件来源"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部来源</SelectItem>{Object.entries(sourceLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></label>
      </div>
    </section>

    {page.error ? <div role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{page.error}</div> : null}
    {page.loading ? <ProjectionSkeleton /> : page.items.length === 0 ? <ProjectionEmpty filtered={Boolean(filters.projectId || filters.sourceKind)} noun="时间线事件" /> : <div className="space-y-8">{grouped.map(([date, events]) => <section key={date} aria-label={`${date}的事件`}><h2 className="sticky top-0 z-10 mb-3 border-b border-border/60 bg-background/90 py-2 text-xs font-bold tracking-wide text-muted-foreground backdrop-blur">{date}</h2><ol className="space-y-3 border-l border-border/80 pl-5">{events?.map(event => <li key={`${event.sourceKind}:${event.sourceId}`} className="relative rounded-xl border border-border/80 bg-card px-4 py-3.5 shadow-sm before:absolute before:-left-[26px] before:top-5 before:size-2.5 before:rounded-full before:border-2 before:border-background before:bg-primary"><div className="grid gap-3 sm:grid-cols-[4.5rem_minmax(0,1fr)]"><time className="font-mono text-xs font-semibold tabular-nums text-muted-foreground">{new Date(event.occurredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-semibold text-primary">{event.action}</span><span className="rounded-md border border-border/70 bg-muted/50 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{sourceLabels[event.sourceKind]}</span><FreshnessBadge freshness={event.freshness} /></div><p className="mt-2.5 text-sm font-medium leading-6">{event.summary}</p><p className="mt-1.5 text-xs leading-5 text-muted-foreground">{event.actor.label} · {event.subject.label}</p></div></div></li>)}</ol></section>)}</div>}
    {page.nextCursor ? <div className="mt-5 text-center"><Button variant="outline" disabled={page.loadingMore} onClick={() => void page.loadMore()}>{page.loadingMore ? '加载中…' : '加载更多'}</Button></div> : null}
  </section>
}
