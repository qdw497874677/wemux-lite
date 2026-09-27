import { Children, createContext, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { ArrowDown } from 'lucide-react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'
import { Button } from '../ui/button.tsx'
import { cn } from '../../lib/utils.ts'
import { createScrollAnchorState, reduceScrollAnchorState, type ScrollAnchorState } from '../../features/sessions/scroll-anchoring.ts'

const ConversationAnchorContext = createContext<{
  state: ScrollAnchorState
  contentAdded: (count: number) => void
  jumpToBottom: () => void
} | null>(null)

export type ConversationProps = ComponentProps<typeof StickToBottom>

export function Conversation({ className, children, ...props }: ConversationProps) {
  const [state, setState] = useState(() => createScrollAnchorState({ distanceFromBottom: 0 }))
  const renderedChildren = typeof children === 'function' ? children : () => children
  return <ConversationAnchorContext.Provider value={{
    state,
    contentAdded: count => setState(current => reduceScrollAnchorState(current, { type: 'content-added', count })),
    jumpToBottom: () => setState(current => reduceScrollAnchorState(current, { type: 'jump-to-bottom' })),
  }}><StickToBottom className={cn('relative min-h-0 flex-1 overflow-y-hidden', className)} initial="smooth" resize="smooth" role="log" {...props}>{context => <><ConversationAnchorObserver onStateChange={setState} />{renderedChildren(context)}</>}</StickToBottom></ConversationAnchorContext.Provider>
}

function ConversationAnchorObserver({ onStateChange }: { onStateChange: (update: (state: ScrollAnchorState) => ScrollAnchorState) => void }) {
  const { scrollRef, scrollToBottom } = useStickToBottomContext()
  const anchor = useContext(ConversationAnchorContext)
  useEffect(() => {
    const viewport = scrollRef.current
    if (!viewport) return
    const update = () => onStateChange(current => reduceScrollAnchorState(current, { type: 'viewport-scrolled', distanceFromBottom: Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) }))
    update()
    viewport.addEventListener('scroll', update, { passive: true })
    return () => viewport.removeEventListener('scroll', update)
  }, [onStateChange, scrollRef])
  useEffect(() => {
    if (!anchor?.state.shouldScrollToBottom) return
    void scrollToBottom()
    onStateChange(current => reduceScrollAnchorState(current, { type: 'scroll-completed' }))
  }, [anchor?.state.shouldScrollToBottom, onStateChange, scrollToBottom])
  return null
}

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>

export function ConversationContent({ className, children, ...props }: ConversationContentProps) {
  const anchor = useContext(ConversationAnchorContext)
  const childCount = Children.count(children)
  const previousChildCount = useRef(childCount)
  useEffect(() => {
    const added = Math.max(0, childCount - previousChildCount.current)
    previousChildCount.current = childCount
    if (added) anchor?.contentAdded(added)
  }, [anchor, childCount])
  return <StickToBottom.Content className={cn('flex flex-col gap-5 p-4 sm:p-6', className)} {...props}>{children}</StickToBottom.Content>
}

export function ConversationEmptyState({ className, title = '暂无消息', description, icon, children, ...props }: ComponentProps<'div'> & { title?: string; description?: string; icon?: ReactNode }) {
  return <div className={cn('flex size-full min-h-48 flex-col items-center justify-center gap-3 p-8 text-center', className)} {...props}>{children ?? <>{icon && <div className="text-muted-foreground">{icon}</div>}<div className="space-y-1"><h3 className="text-sm font-medium">{title}</h3>{description && <p className="text-sm text-muted-foreground">{description}</p>}</div></>}</div>
}

export function ConversationScrollButton({ className, ...props }: ComponentProps<typeof Button>) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()
  const anchor = useContext(ConversationAnchorContext)
  if (isAtBottom) return null
  const unreadCount = anchor?.state.unreadCount ?? 0
  const label = unreadCount > 0 ? `${unreadCount} 条新消息` : '跳到最新消息'
  return <Button className={cn('absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-lg', className)} onClick={() => { anchor?.jumpToBottom(); void scrollToBottom() }} size={unreadCount > 0 ? 'sm' : 'icon-sm'} type="button" variant="outline" aria-label={label} {...props}><ArrowDown className="size-4" />{unreadCount > 0 && <span>{label}</span>}</Button>
}
