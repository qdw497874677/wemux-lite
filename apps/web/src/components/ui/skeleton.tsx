import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/** Skeleton recipe ported from TailGrids (MIT): uses --animate-pulse-custom + --color-skeleton-gradient-50. */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div aria-hidden className={cn('animate-pulse-custom h-3 rounded-full bg-skeleton-gradient-50', className)} {...props} />
}