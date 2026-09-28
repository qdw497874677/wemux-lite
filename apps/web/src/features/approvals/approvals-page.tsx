import { useCallback, useMemo, useState } from 'react'
import { Check, ChevronRight, Filter, RefreshCw, X } from 'lucide-react'
import type { ProjectDTO } from '../../api/dto.ts'
import { InspectorHost } from '../../app/shell.tsx'
import { Button } from '../../components/ui/button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select.tsx'
import { randomId } from '../../lib/random.ts'
import { decideApproval, fetchApprovals } from '../projections/projection-client.ts'
import { ApprovalStatusBadge, FreshnessBadge, ProjectionEmpty, ProjectionSkeleton } from '../projections/projection-ui.tsx'
import { useProjectionPage } from '../projections/use-projection-page.ts'
import { groupByKey } from '../projections/group.ts'
import type { ApprovalView, ProjectionFilters } from '../projections/projection-model.ts'

const sourceLabels = { session_tool: 'Session 工具', connector_call: 'Connector 调用', task_review: 'Task Review', channel_governance: 'Channel 治理' } as const
const statusLabels = { pending: '待审批', approved: '已批准', denied: '已拒绝', changes_requested: '需修改', expired: '已过期', unavailable: '不可用' } as const

async function fingerprint(input: { readonly decision: string; readonly requestId: string; readonly sourceRevision: string }): Promise<string> {
  const canonical = JSON.stringify({ decision: input.decision, note: null, requestId: input.requestId, sourceRevision: input.sourceRevision })
  const bytes = new TextEncoder().encode(canonical), hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('')
}

export function ApprovalsPage({ projects }: { readonly projects: readonly ProjectDTO[] }) {
  const [filters, setFilters] = useState<ProjectionFilters>({ projectId: new URLSearchParams(location.search).get('projectId') ?? undefined, status: 'pending' })
  const [selected, setSelected] = useState<ApprovalView | null>(null), [deciding, setDeciding] = useState(false)
  const dependencyKey = JSON.stringify(filters), load = useCallback((cursor?: string) => fetchApprovals(filters, cursor), [dependencyKey])
  const page = useProjectionPage(load, dependencyKey), filtered = Boolean(filters.projectId || filters.sourceKind || (filters.status && filters.status !== 'pending'))
  const act = async (approval: ApprovalView, decision: 'approve' | 'deny' | 'changes_requested') => {
    setDeciding(true)
    try {
      const requestId = randomId(), sourceRevision = approval.sourceRevision
      const updated = await decideApproval(approval.projectionKey, { decision, requestId, sourceRevision, fingerprint: await fingerprint({ decision, requestId, sourceRevision }) })
      page.setItems(items => items.map(item => item.projectionKey === updated.projectionKey ? updated : item).filter(item => filters.status !== 'pending' || item.status === 'pending'))
      setSelected(updated)
    } finally { setDeciding(false) }
  }
  const groups = useMemo(() => groupByKey(page.items, item => new Date(item.requestedAt).toLocaleDateString('zh-CN')), [page.items])

  return <section className="mx-auto max-w-6xl p-4 md:p-6">
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">跨 Session 聚合</p><h1 className="mt-1 text-2xl font-bold">待审批</h1><p className="mt-1 text-sm text-muted-foreground">集中查看，但每次只处理一条审批。Session 内联审批仍然保留。</p></div>
      <Button variant="outline" onClick={() => void page.refresh()}><RefreshCw size={14} />刷新</Button>
    </header>

    <section aria-labelledby="approval-filter-title" className="mb-7 rounded-xl border border-border/80 bg-card/60 p-4 shadow-sm">
      <div className="mb-4 flex items-start gap-2.5 border-b border-border/70 pb-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border/70 bg-muted/50 text-muted-foreground"><Filter size={15} /></span>
        <div><h2 id="approval-filter-title" className="text-sm font-semibold">筛选审批</h2><p className="mt-0.5 text-xs text-muted-foreground">按项目、来源与处理状态缩小结果范围。</p></div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">项目</span><Select value={filters.projectId ?? 'all'} onValueChange={value => setFilters(current => ({ ...current, projectId: value === 'all' ? undefined : value }))}><SelectTrigger aria-label="筛选项目"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部项目</SelectItem>{projects.map(project => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent></Select></label>
        <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">来源</span><Select value={filters.sourceKind ?? 'all'} onValueChange={value => setFilters(current => ({ ...current, sourceKind: value === 'all' ? undefined : value }))}><SelectTrigger aria-label="筛选来源"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部来源</SelectItem>{Object.entries(sourceLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></label>
        <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">状态</span><Select value={filters.status ?? 'all'} onValueChange={value => setFilters(current => ({ ...current, status: value === 'all' ? undefined : value }))}><SelectTrigger aria-label="筛选状态"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem>{Object.entries(statusLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></label>
      </div>
    </section>

    {page.error ? <div role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{page.error}</div> : null}
    {page.loading ? <ProjectionSkeleton /> : page.items.length === 0 ? <ProjectionEmpty filtered={filtered} noun="审批" /> : <div className="space-y-7">{groups.map(([date, items]) => <section key={date} aria-label={`${date}的审批`}><h2 className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground">{date}</h2><div className="space-y-3">{items?.map(item => <button key={item.projectionKey} onClick={() => setSelected(item)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-xl border border-border/80 bg-card px-4 py-3.5 text-left shadow-sm transition hover:border-primary/50 hover:bg-card/90"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="min-w-0 truncate text-sm font-semibold">{item.title}</span><span className="rounded-md border border-border/70 bg-muted/50 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{sourceLabels[item.source.kind]}</span><FreshnessBadge freshness={item.freshness} /></div><p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.reason ?? `${item.requestedBy.kind} · ${item.requestedBy.id}`}</p></div><div className="flex items-center gap-3"><ApprovalStatusBadge status={item.status} /><ChevronRight size={16} className="text-muted-foreground" /></div></button>)}</div></section>)}</div>}
    {page.nextCursor ? <div className="mt-5 text-center"><Button variant="outline" disabled={page.loadingMore} onClick={() => void page.loadMore()}>{page.loadingMore ? '加载中…' : '加载更多'}</Button></div> : null}

    <InspectorHost open={selected !== null} onOpenChange={open => { if (!open) setSelected(null) }}>{selected ? <div className="space-y-4"><div><h2 className="font-bold">审批详情</h2><h3 className="mt-1 font-bold">{selected.title}</h3><div className="mt-3 flex flex-wrap gap-2"><ApprovalStatusBadge status={selected.status} /><FreshnessBadge freshness={selected.freshness} /></div></div><p className="text-sm leading-6 text-muted-foreground">{selected.reason ?? '未提供审批原因'}</p>{selected.status === 'pending' ? <div className="grid grid-cols-2 gap-2">{selected.decisionCapabilities.includes('approve') ? <Button disabled={deciding} onClick={() => void act(selected, 'approve')}><Check size={14} />批准</Button> : null}{selected.decisionCapabilities.includes('deny') ? <Button variant="destructive" disabled={deciding} onClick={() => void act(selected, 'deny')}><X size={14} />拒绝</Button> : null}{selected.decisionCapabilities.includes('changes_requested') ? <Button variant="outline" disabled={deciding} onClick={() => void act(selected, 'changes_requested')}><X size={14} />要求修改</Button> : null}</div> : null}</div> : null}</InspectorHost>
  </section>
}
