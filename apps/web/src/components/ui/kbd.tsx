/* Derived from pingdotgg/t3code (MIT). */
import type * as React from 'react'
import { cn } from '../../lib/utils.ts'

export function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-0.5 rounded-[calc(var(--control-radius)-2px)] border border-contrast-border bg-muted px-1 font-medium font-sans text-contrast-muted-foreground text-[0.6875rem] leading-none shadow-xs',
        className,
      )}
      data-slot="kbd"
      {...props}
    />
  )
}
