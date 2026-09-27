import { createContext, useContext, type ComponentProps, type ReactNode } from 'react'
import { File, FileText, X } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { Button } from '../ui/button.tsx'

export interface PromptInputAttachment {
  id: string
  file: File
  name: string
  type: string
  size: number
  url: string
}

type AttachmentContextValue = { attachment: PromptInputAttachment; onRemove?: () => void }
const AttachmentContext = createContext<AttachmentContextValue | null>(null)

export function Attachments({ className, variant = 'inline', ...props }: ComponentProps<'div'> & { variant?: 'inline' | 'grid' }) {
  return <div className={cn(variant === 'grid' ? 'grid grid-cols-2 gap-2' : 'flex flex-wrap gap-2', className)} {...props} />
}

export function Attachment({ data, onRemove, className, children, ...props }: Omit<ComponentProps<'div'>, 'data'> & { data: PromptInputAttachment; onRemove?: () => void; children: ReactNode }) {
  return <AttachmentContext.Provider value={{ attachment: data, onRemove }}><div className={cn('group flex min-w-0 max-w-64 items-center gap-2 rounded-xl border border-border bg-muted/55 p-2 text-left', className)} {...props}>{children}</div></AttachmentContext.Provider>
}

export function AttachmentPreview({ className }: { className?: string }) {
  const context = useContext(AttachmentContext)
  if (!context) return null
  const { attachment } = context
  if (attachment.type.startsWith('image/')) return <img className={cn('size-10 shrink-0 rounded-lg object-cover', className)} src={attachment.url} alt="" />
  const Icon = attachment.type.startsWith('text/') ? FileText : File
  return <span className={cn('grid size-10 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground', className)}><Icon className="size-5" /></span>
}

export function AttachmentInfo() {
  const context = useContext(AttachmentContext)
  if (!context) return null
  return <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{context.attachment.name}</span><span className="block text-[10px] text-muted-foreground">{formatAttachmentSize(context.attachment.size)}</span></span>
}

export function AttachmentRemove() {
  const context = useContext(AttachmentContext)
  if (!context?.onRemove) return null
  return <Button type="button" variant="ghost" size="icon-sm" className="size-7 shrink-0 rounded-lg" onClick={context.onRemove} aria-label={`移除附件 ${context.attachment.name}`}><X className="size-3.5" /></Button>
}

export function formatAttachmentSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
