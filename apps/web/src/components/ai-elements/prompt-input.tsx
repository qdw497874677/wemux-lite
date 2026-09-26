import { createContext, useContext, useRef, useState, type ComponentProps, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowUp, LoaderCircle, Square } from 'lucide-react'
import { Button } from '../ui/button.tsx'
import { cn } from '../../lib/utils.ts'

export type PromptInputMessage = { text: string }
export type PromptInputStatus = 'submitted' | 'streaming' | 'ready' | 'error'

type PromptInputContextValue = { textareaRef: React.RefObject<HTMLTextAreaElement | null> }
const PromptInputContext = createContext<PromptInputContextValue | null>(null)

export function PromptInput({ className, onSubmit, children, ...props }: Omit<ComponentProps<'form'>, 'onSubmit'> & { onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void; children: ReactNode }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); onSubmit({ text: String(data.get('message') ?? '') }, event) }
  return <PromptInputContext.Provider value={{ textareaRef }}><form className={cn('overflow-hidden rounded-2xl border border-border bg-card shadow-sm focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/15', className)} onSubmit={submit} {...props}>{children}</form></PromptInputContext.Provider>
}

export function PromptInputTextarea({ className, onKeyDown, ...props }: ComponentProps<'textarea'>) {
  const context = useContext(PromptInputContext)
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented || event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }
  return <textarea ref={context?.textareaRef} name="message" rows={2} className={cn('max-h-48 min-h-14 w-full resize-none bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60', className)} onKeyDown={handleKeyDown} {...props} />
}

export function PromptInputFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex min-h-12 items-center gap-2 border-t border-border/70 px-3 py-2', className)} {...props} />
}

export function PromptInputTools({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex min-w-0 flex-1 items-center gap-2', className)} {...props} />
}

export function PromptInputSubmit({ className, status = 'ready', onStop, children, ...props }: ComponentProps<typeof Button> & { status?: PromptInputStatus; onStop?: () => void }) {
  const busy = status === 'submitted' || status === 'streaming'
  return <Button className={cn('rounded-xl', className)} iconOnly size="sm" type={busy && onStop ? 'button' : 'submit'} aria-label={busy && onStop ? '停止当前回合' : busy ? '正在发送' : '发送消息'} onClick={busy && onStop ? onStop : props.onClick} {...props}>{children ?? (busy ? onStop ? <Square className="size-4 fill-current" /> : <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />)}</Button>
}

export function usePromptInputController(initialValue = '') {
  const [value, setValue] = useState(initialValue)
  return { textInput: { value, setInput: setValue, clear: () => setValue('') } }
}
