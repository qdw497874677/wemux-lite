import type { ComponentProps, ReactNode } from 'react'
import { ArrowDown } from 'lucide-react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'
import { Button } from '../ui/button.tsx'
import { cn } from '../../lib/utils.ts'

export type ConversationProps = ComponentProps<typeof StickToBottom>

export function Conversation({ className, ...props }: ConversationProps) {
  return <StickToBottom className={cn('relative min-h-0 flex-1 overflow-y-hidden', className)} initial="smooth" resize="smooth" role="log" {...props} />
}

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>

export function ConversationContent({ className, ...props }: ConversationContentProps) {
  return <StickToBottom.Content className={cn('flex flex-col gap-5 p-4 sm:p-6', className)} {...props} />
}

export function ConversationEmptyState({ className, title = '暂无消息', description, icon, children, ...props }: ComponentProps<'div'> & { title?: string; description?: string; icon?: ReactNode }) {
  return <div className={cn('flex size-full min-h-48 flex-col items-center justify-center gap-3 p-8 text-center', className)} {...props}>{children ?? <>{icon && <div className="text-muted-foreground">{icon}</div>}<div className="space-y-1"><h3 className="text-sm font-medium">{title}</h3>{description && <p className="text-sm text-muted-foreground">{description}</p>}</div></>}</div>
}

export function ConversationScrollButton({ className, ...props }: ComponentProps<typeof Button>) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()
  if (isAtBottom) return null
  return <Button className={cn('absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-lg', className)} onClick={() => scrollToBottom()} size="icon-sm" type="button" variant="outline" aria-label="跳到最新消息" {...props}><ArrowDown className="size-4" /></Button>
}
