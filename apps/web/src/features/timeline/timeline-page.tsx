import { useCallback, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { ProjectDTO } from '../../api/dto.ts'
import { Button } from '../../components/ui/button.tsx'
import { Select } from '../../components/ui/select.tsx'
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
  return <section className="mx-auto max-w-6xl p-4 md:p-6"><header className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">统一只读投影</p><h1 className="mt-1 text-2xl font-bold">时间线</h1><p className="mt-1 text-sm text-muted-foreground">按发生时间汇总项目活动与审计事件。</p></div><Button variant="outline" onClick={() => void page.refresh()}><RefreshCw size={14} />刷新</Button></header>
    <div className="mb-4 grid gap-2 sm:grid-cols-2"><Select aria-label="筛选项目" value={filters.projectId ?? ''} onValueChange={value => setFilters(current => ({ ...current, projectId: value || undefined }))}><option value="">全部项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</Select><Select aria-label="筛选事件来源" value={filters.sourceKind ?? ''} onValueChange={value => setFilters(current => ({ ...current, sourceKind: value || undefined }))}><option value="">全部来源</option>{Object.entries(sourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></div>
    {page.error ? <div role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{page.error}</div> : null}
    {page.loading ? <ProjectionSkeleton /> : page.items.length === 0 ? <ProjectionEmpty filtered={Boolean(filters.projectId || filters.sourceKind)} noun="时间线事件" /> : <div className="space-y-6">{grouped.map(([date, events]) => <div key={date}><h2 className="sticky top-0 z-10 mb-2 bg-background/90 py-1 text-xs font-bold text-muted-foreground backdrop-blur">{date}</h2><ol className="space-y-2 border-l border-border pl-4">{events?.map(event => <li key={`${event.sourceKind}:${event.sourceId}`} className="relative rounded-xl border border-border bg-card p-3 before:absolute before:-left-[21px] before:top-5 before:h-2 before:w-2 before:rounded-full before:bg-primary"><div className="flex flex-wrap items-center gap-2"><time className="text-xs font-semibold">{new Date(event.occurredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{sourceLabels[event.sourceKind]}</span><FreshnessBadge freshness={event.freshness} /></div><p className="mt-2 text-sm font-medium">{event.summary}</p><p className="mt-1 text-xs text-muted-foreground">{event.actor.label} · {event.subject.label}</p></li>)}</ol></div>)}</div>}
    {page.nextCursor ? <div className="mt-4 text-center"><Button variant="outline" disabled={page.loadingMore} onClick={() => void page.loadMore()}>{page.loadingMore ? '加载中…' : '加载更多'}</Button></div> : null}
  </section>
}
