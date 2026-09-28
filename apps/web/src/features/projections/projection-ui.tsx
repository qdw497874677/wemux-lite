import { cn } from '../../lib/utils.ts'
import type { ProjectionFreshness } from './projection-model.ts'

const freshnessLabels = { current: '最新', syncing: '同步中', stale: '可能过期', offline: '节点离线', unavailable: '新鲜度未知' } as const
export function FreshnessBadge({ freshness }: { readonly freshness: ProjectionFreshness }) {
  const warn = freshness.status !== 'current'
  return <span title={freshness.detail ?? `观测于 ${new Date(freshness.observedAt).toLocaleString('zh-CN')}`} className={cn('inline-flex rounded border px-1.5 py-0.5 text-[10px] font-semibold', warn ? 'border-amber-500/35 bg-amber-500/10 text-amber-300' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300')}>{freshnessLabels[freshness.status]}</span>
}
export function ProjectionSkeleton() {
  return <div className="space-y-2" aria-label="正在加载"><div className="h-16 animate-pulse rounded-lg bg-muted/60" /><div className="h-16 animate-pulse rounded-lg bg-muted/40" /><div className="h-16 animate-pulse rounded-lg bg-muted/30" /></div>
}
export function ProjectionEmpty({ filtered, noun }: { readonly filtered: boolean; readonly noun: string }) {
  return <div className="rounded-xl border border-dashed border-border p-10 text-center"><p className="text-sm font-semibold text-foreground">{filtered ? `没有匹配的${noun}` : `暂无${noun}`}</p><p className="mt-2 text-xs text-muted-foreground">{filtered ? '调整筛选条件后重试。' : '产生相关活动后会显示在这里。'}</p></div>
}
