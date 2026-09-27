import type { ComponentProps } from 'react'
import { MarkdownMessage } from '../markdown-message.ts'
import { cn } from '../../lib/utils.ts'

export function Response({ className, children, partial = false, ...props }: ComponentProps<'div'> & { partial?: boolean }) {
  return <div className={cn('min-w-0', className)} {...props}><MarkdownMessage text={String(children ?? '')} partial={partial} /></div>
}
