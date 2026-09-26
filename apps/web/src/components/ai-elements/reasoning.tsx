import type { ComponentProps } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

export function Reasoning({ className, ...props }: ComponentProps<'details'> & { duration?: number }) {
  return <details className={cn('group mb-2 rounded-xl border border-border/70 bg-muted/35 px-3 py-2 text-sm', className)} {...props} />
}

export function ReasoningTrigger({ duration, running = false, className, ...props }: ComponentProps<'summary'> & { duration?: number; running?: boolean }) {
  const label = running ? '思考中…' : duration && duration > 0 ? `已思考 ${duration} 秒` : '查看思考过程'
  return <summary className={cn('flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden', className)} {...props}><Brain className="size-3.5" /><span>{label}</span><ChevronDown className="ml-auto size-3.5 transition-transform group-open:rotate-180" /></summary>
}

export function ReasoningContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mt-2 whitespace-pre-wrap border-t border-border/60 pt-2 text-xs leading-5 text-muted-foreground', className)} {...props} />
}
