import { createContext, useCallback, useContext, useEffect, useRef, useState, type ChangeEvent, type ComponentProps, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowUp, FilePlus2, ImagePlus, LoaderCircle, Paperclip, Square } from 'lucide-react'
import { Button } from '../ui/button.tsx'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.tsx'
import { cn } from '../../lib/utils.ts'
import { randomId } from '../../lib/random.ts'
import type { PromptInputAttachment } from './attachments.tsx'

export type PromptInputMessage = { text: string; files?: PromptInputAttachment[] }
export type PromptInputStatus = 'submitted' | 'streaming' | 'ready' | 'error'

type PromptInputContextValue = {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  files: PromptInputAttachment[]
  add: (files: FileList | File[]) => void
  remove: (id: string) => void
  clear: () => void
  fileInputRef: React.RefObject<HTMLInputElement | null>
  imageInputRef: React.RefObject<HTMLInputElement | null>
}
const PromptInputContext = createContext<PromptInputContextValue | null>(null)

export function PromptInput({ className, onSubmit, children, ...props }: Omit<ComponentProps<'form'>, 'onSubmit'> & { onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void; children: ReactNode }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<PromptInputAttachment[]>([])
  const add = useCallback((incoming: FileList | File[]) => {
    setFiles(current => [...current, ...Array.from(incoming).map(file => ({ id: randomId(), file, name: file.name, type: file.type, size: file.size, url: URL.createObjectURL(file) }))])
  }, [])
  const remove = useCallback((id: string) => setFiles(current => {
    const removed = current.find(item => item.id === id)
    if (removed) URL.revokeObjectURL(removed.url)
    return current.filter(item => item.id !== id)
  }), [])
  const clear = useCallback(() => setFiles(current => { current.forEach(item => URL.revokeObjectURL(item.url)); return [] }), [])
  useEffect(() => clear, [clear])
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    onSubmit({ text: String(data.get('message') ?? ''), files }, event)
  }
  const context = { textareaRef, files, add, remove, clear, fileInputRef, imageInputRef }
  return <PromptInputContext.Provider value={context}><form className={cn('surface-glass overflow-hidden rounded-xl border border-border/70 bg-card/80 shadow-[0_12px_36px_-24px_rgb(0_0_0/.8)] transition-[border-color,box-shadow,background-color] focus-within:border-primary/45 focus-within:bg-card/90 focus-within:ring-2 focus-within:ring-primary/15', className)} onSubmit={submit} {...props}>{children}<input ref={fileInputRef} className="sr-only" type="file" multiple onChange={event => { if (event.target.files) add(event.target.files); event.target.value = '' }} /><input ref={imageInputRef} className="sr-only" type="file" accept="image/*" multiple onChange={event => { if (event.target.files) add(event.target.files); event.target.value = '' }} /></form></PromptInputContext.Provider>
}

export function PromptInputHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('border-b border-border/70 px-3 py-2', className)} {...props} />
}

export function PromptInputBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={className} {...props} />
}

export function PromptInputTextarea({ className, onKeyDown, ...props }: ComponentProps<'textarea'>) {
  const context = useContext(PromptInputContext)
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented || event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }
  return <textarea ref={context?.textareaRef} name="message" rows={2} className={cn('max-h-48 min-h-12 w-full resize-none bg-transparent px-3.5 py-3 text-sm leading-6 outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-60', className)} onKeyDown={handleKeyDown} {...props} />
}

export function PromptInputFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex min-h-10 items-center gap-2 border-t border-border/55 px-2.5 py-1.5', className)} {...props} />
}

export function PromptInputTools({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex min-w-0 flex-1 items-center gap-2', className)} {...props} />
}

export function PromptInputSubmit({ className, status = 'ready', onStop, children, ...props }: ComponentProps<typeof Button> & { status?: PromptInputStatus; onStop?: () => void }) {
  const busy = status === 'submitted' || status === 'streaming'
  return <Button className={cn('size-8 rounded-lg', className)} iconOnly size="icon-sm" type={busy && onStop ? 'button' : 'submit'} aria-label={busy && onStop ? '停止当前回合' : busy ? '正在发送' : '发送消息'} onClick={busy && onStop ? onStop : props.onClick} {...props}>{children ?? (busy ? onStop ? <Square className="size-3.5 fill-current" /> : <LoaderCircle className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />)}</Button>
}

export const PromptInputActionMenu = DropdownMenu
export const PromptInputActionMenuTrigger = DropdownMenuTrigger
export const PromptInputActionMenuContent = DropdownMenuContent

export function PromptInputActionMenuButton({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button type="button" size="icon-sm" variant="ghost" className={cn('rounded-lg', className)} aria-label="添加附件" {...props}><Paperclip className="size-4" /></Button>
}

export function PromptInputActionAddAttachments({ kind = 'file' }: { kind?: 'file' | 'image' }) {
  const context = useContext(PromptInputContext)
  const image = kind === 'image'
  return <DropdownMenuItem onSelect={() => window.setTimeout(() => { const input = image ? context?.imageInputRef.current : context?.fileInputRef.current; input?.click() }, 0)}>{image ? <ImagePlus /> : <FilePlus2 />}{image ? '添加图片' : '添加文件'}</DropdownMenuItem>
}

export function usePromptInputAttachments() {
  const context = useContext(PromptInputContext)
  if (!context) throw new Error('usePromptInputAttachments must be used inside PromptInput')
  return { files: context.files, add: context.add, remove: context.remove, clear: context.clear }
}

export function usePromptInputController(initialValue = '') {
  const [value, setValue] = useState(initialValue)
  return { textInput: { value, setInput: setValue, clear: () => setValue('') } }
}
