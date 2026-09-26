import type { ComponentProps } from 'react'
import { Button } from '../ui/button.tsx'
import { cn } from '../../lib/utils.ts'

export function ActionsBar({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100', className)} {...props} />
}

export function Action({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button type="button" variant="ghost" size="icon-xs" className={cn('rounded-lg text-muted-foreground', className)} {...props} />
}
