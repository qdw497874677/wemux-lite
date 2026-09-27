import * as Collapsible from '@radix-ui/react-collapsible'
import { CheckCircle, ChevronDown, Circle, Clock, Wrench, XCircle } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import { Badge } from '../ui/badge.tsx'
import { cn } from '../../lib/utils.ts'

export type ToolPart = ToolUIPart | DynamicToolUIPart
export type ToolState = ToolPart['state']

export function Tool({ className, ...props }: ComponentProps<typeof Collapsible.Root>) {
  return <Collapsible.Root className={cn('group/tool w-full overflow-hidden rounded-2xl border border-border bg-card/70 text-xs shadow-sm', className)} {...props} />
}

const statusLabels: Record<ToolState, string> = {
  'approval-requested': '等待审批',
  'approval-responded': '审批已响应',
  'input-available': '正在执行',
  'input-streaming': '准备中',
  'output-available': '执行完成',
  'output-denied': '已拒绝',
  'output-error': '执行失败',
}
const statusIcons: Record<ToolState, ReactNode> = {
  'approval-requested': <Clock className="size-3.5 text-amber-400" />,
  'approval-responded': <CheckCircle className="size-3.5 text-blue-400" />,
  'input-available': <Clock className="size-3.5 animate-pulse text-amber-400" />,
  'input-streaming': <Circle className="size-3.5 text-muted-foreground" />,
  'output-available': <CheckCircle className="size-3.5 text-emerald-400" />,
  'output-denied': <XCircle className="size-3.5 text-orange-400" />,
  'output-error': <XCircle className="size-3.5 text-red-400" />,
}

export function ToolHeader({ className, title, state, icon, ...props }: ComponentProps<typeof Collapsible.Trigger> & { title: string; state: ToolState; icon?: ReactNode }) {
  return <Collapsible.Trigger className={cn('flex w-full items-center justify-between gap-4 p-3 text-left', className)} {...props}><span className="flex min-w-0 items-center gap-2">{icon ?? <Wrench className="size-4 shrink-0 text-violet-300" />}<strong className="truncate font-mono text-sm">{title}</strong><Badge className="gap-1.5 rounded-full text-xs" variant="secondary">{statusIcons[state]}{statusLabels[state]}</Badge></span><ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/tool:rotate-180" /></Collapsible.Trigger>
}

export function ToolContent({ className, ...props }: ComponentProps<typeof Collapsible.Content>) {
  return <Collapsible.Content className={cn('space-y-4 border-t border-border p-4 text-popover-foreground', className)} {...props} />
}

export function ToolInput({ className, input, ...props }: ComponentProps<'div'> & { input: unknown }) {
  return <div className={cn('space-y-2 overflow-hidden', className)} {...props}><h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">调用参数</h4><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-xs leading-5">{typeof input === 'string' ? input : JSON.stringify(input, null, 2)}</pre></div>
}

export function ToolOutput({ className, output, errorText, ...props }: ComponentProps<'div'> & { output?: string; errorText?: string }) {
  if (!output && !errorText) return null
  return <div className={cn('space-y-2', className)} {...props}><h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{errorText ? '错误' : '工具输出'}</h4><pre className={cn('max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md p-3 font-mono text-xs leading-5', errorText ? 'bg-destructive/10 text-destructive' : 'bg-muted/50 text-foreground')}>{errorText || output}</pre></div>
}
