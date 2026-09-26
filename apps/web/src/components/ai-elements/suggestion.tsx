import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils.ts'

export function Suggestions({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-wrap justify-center gap-2', className)} {...props} />
}

export function Suggestion({ suggestion, className, children, ...props }: ComponentProps<'button'> & { suggestion: string }) {
  return <button type="button" className={cn('rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/45 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40', className)} {...props}>{children ?? suggestion}</button>
}
