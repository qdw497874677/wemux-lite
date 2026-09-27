import { useEffect, useRef, useState } from 'react'
import { Minimize2 } from 'lucide-react'

import { Button } from './ui/button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.tsx'

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
  const roundedPercentage = Math.round(percentage)
  const radius = 9.75
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - percentage / 100)
  const progressColor = percentage > 90 ? 'var(--status-danger)' : 'color-mix(in oklab, var(--muted-foreground) 72%, transparent)'
  const [open, setOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }
  useEffect(() => clearTimer, [])
  const scheduleOpen = () => {
    clearTimer()
    timerRef.current = setTimeout(() => setOpen(true), 150)
  }
  const scheduleClose = () => {
    clearTimer()
    timerRef.current = setTimeout(() => setOpen(false), 150)
  }
  const ariaLabel = validUsage ? `上下文用量 ${roundedPercentage}%，${formatTokens(validUsage.usedTokens)} / ${formatTokens(validUsage.maxTokens)} tokens` : '上下文用量未知'

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button type="button" variant="ghost-muted" size="icon-xs" className="size-7" aria-label={ariaLabel} onMouseEnter={scheduleOpen} onMouseLeave={scheduleClose} onFocus={() => { clearTimer(); setOpen(true) }} onBlur={scheduleClose}>
        <span className="relative flex size-5 items-center justify-center">
          <svg viewBox="0 0 24 24" className="absolute inset-0 size-full -rotate-90 transform-gpu" aria-hidden="true">
            <circle cx="12" cy="12" r={radius} fill="none" className="stroke-muted-foreground/24" strokeWidth="3" />
            <circle cx="12" cy="12" r={radius} fill="none" stroke={progressColor} strokeWidth="3" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={dashOffset} className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none" />
          </svg>
        </span>
      </Button>
    </PopoverTrigger>
    <PopoverContent side="top" align="end" className="w-72 p-3 text-left" onMouseEnter={clearTimer} onMouseLeave={scheduleClose} onOpenAutoFocus={event => event.preventDefault()}>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground">Context Window</span>
          <span className="text-xs tabular-nums text-muted-foreground">{validUsage ? `${roundedPercentage}%` : '用量未知'}</span>
        </div>
        {validUsage ? <>
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">已用 / 上限</span>
            <span className="font-medium tabular-nums">{formatTokens(validUsage.usedTokens)} / {formatTokens(validUsage.maxTokens)} tokens</span>
          </div>
          {threshold !== null && <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">压缩阈值</span>
            <span className="font-medium tabular-nums">{formatTokens(validUsage.compactThreshold!)} tokens · {Math.round(threshold)}%</span>
          </div>}
        </> : <p className="text-xs text-muted-foreground">当前会话尚未提供上下文用量数据。</p>}
        {onCompact && <Button type="button" variant="outline" size="xs" className="mt-1 w-full justify-center" disabled={compactDisabled} onClick={onCompact}><Minimize2 className="size-3.5" aria-hidden="true" />压缩上下文</Button>}
      </div>
    </PopoverContent>
  </Popover>
}
