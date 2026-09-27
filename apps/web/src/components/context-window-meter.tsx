import { Minimize2 } from 'lucide-react'

import { Button } from './ui/button.tsx'
import { cn } from '../lib/utils.ts'

export interface ContextWindowUsage {
  usedTokens: number
  maxTokens: number
  compactThreshold?: number
}

const formatTokens = (value: number) => new Intl.NumberFormat('zh-CN', { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)

export function ContextWindowMeter({ usage, onCompact, compactDisabled = false }: { usage?: ContextWindowUsage | null; onCompact?: () => void; compactDisabled?: boolean }) {
  const validUsage = usage && Number.isFinite(usage.usedTokens) && usage.usedTokens >= 0 && Number.isFinite(usage.maxTokens) && usage.maxTokens > 0 ? usage : null
  const percentage = validUsage ? Math.max(0, Math.min(100, validUsage.usedTokens / validUsage.maxTokens * 100)) : 0
  const threshold = validUsage && Number.isFinite(validUsage.compactThreshold) && (validUsage.compactThreshold ?? 0) > 0 ? Math.max(0, Math.min(100, validUsage.compactThreshold! / validUsage.maxTokens * 100)) : null
  return <div className="mb-2 rounded-xl border border-border bg-card/70 px-3 py-2" aria-label="上下文用量">
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-center justify-between gap-3 text-xs"><span className="font-medium text-muted-foreground">上下文用量</span><span className="tabular-nums text-muted-foreground">{validUsage ? `${formatTokens(validUsage.usedTokens)} / ${formatTokens(validUsage.maxTokens)} · ${Math.round(percentage)}%` : '用量未知'}</span></div>
        <div className="relative h-1.5 overflow-hidden rounded-full bg-muted" role={validUsage ? 'progressbar' : undefined} aria-valuemin={validUsage ? 0 : undefined} aria-valuemax={validUsage ? 100 : undefined} aria-valuenow={validUsage ? Math.round(percentage) : undefined}>
          {validUsage && <div className={cn('h-full rounded-full transition-[width,background-color] duration-500', percentage >= 90 ? 'bg-red-400' : percentage >= 70 ? 'bg-amber-400' : 'bg-violet-400')} style={{ width: `${percentage}%` }} />}
          {threshold !== null && <span className="absolute inset-y-0 w-px bg-foreground/70" style={{ left: `${threshold}%` }} title={`压缩阈值 ${formatTokens(validUsage!.compactThreshold!)}`} />}
        </div>
      </div>
      {onCompact && <Button type="button" variant="outline" size="sm" disabled={compactDisabled} onClick={onCompact} title="执行 /compact"><Minimize2 className="size-3.5" />压缩</Button>}
    </div>
  </div>
}
