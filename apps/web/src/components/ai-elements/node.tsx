import { Handle, Position } from '@xyflow/react'
import type { ComponentProps } from 'react'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../ui/card.tsx'
import { cn } from '../../lib/utils.ts'

export type NodeProps = ComponentProps<typeof Card> & {
  handles: { readonly target: boolean; readonly source: boolean }
}

export function Node({ handles, className, children, ...props }: NodeProps) {
  return <Card className={cn('node-container relative size-full h-auto w-72 gap-0 overflow-visible rounded-xl border border-border bg-card p-0 shadow-lg', className)} {...props}>
    {handles.target && <Handle position={Position.Left} type="target" />}
    {handles.source && <Handle position={Position.Right} type="source" />}
    {children}
  </Card>
}

export function NodeHeader({ className, ...props }: ComponentProps<typeof CardHeader>) {
  return <CardHeader className={cn('rounded-t-xl border-b border-border/70 bg-accent/35 px-3 py-3', className)} {...props} />
}

export function NodeTitle({ className, ...props }: ComponentProps<typeof CardTitle>) {
  return <CardTitle className={cn('text-sm leading-5 font-semibold text-foreground', className)} {...props} />
}

export function NodeDescription({ className, ...props }: ComponentProps<typeof CardDescription>) {
  return <CardDescription className={cn('mt-1 text-xs leading-5 text-muted-foreground', className)} {...props} />
}

export function NodeAction({ className, ...props }: ComponentProps<typeof CardAction>) {
  return <CardAction className={cn('top-2.5 right-2.5 text-muted-foreground', className)} {...props} />
}

export function NodeContent({ className, ...props }: ComponentProps<typeof CardContent>) {
  return <CardContent className={cn('px-3 py-3', className)} {...props} />
}

export function NodeFooter({ className, ...props }: ComponentProps<typeof CardFooter>) {
  return <CardFooter className={cn('rounded-b-xl border-t border-border/70 bg-accent/20 px-3 py-2.5', className)} {...props} />
}
