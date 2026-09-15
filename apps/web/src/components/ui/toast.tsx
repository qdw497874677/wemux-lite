import type { ComponentProps, ReactNode } from 'react'
import { CheckCircle2, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Toast({ children, onClose, tone = 'info', className, ...props }: ComponentProps<'div'> & { children: ReactNode; onClose: () => void; tone?: 'info' | 'success' }) {
  const Icon = tone === 'success' ? CheckCircle2 : Info
  return (
    <div role="status" className={cn('fixed inset-x-3 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[100] mx-auto flex max-w-sm items-start gap-3 rounded-xl border border-border bg-popover p-3 text-sm shadow-2xl sm:inset-x-auto sm:bottom-5 sm:right-5 sm:mx-0', className)} {...props}>
      <Icon className={cn('mt-0.5 size-4 shrink-0 text-indigo-300', tone === 'success' && 'text-emerald-400')} />
      <div className="min-w-0 flex-1 leading-5">{children}</div>
      <button type="button" className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose} aria-label="关闭提示"><X className="size-3.5" /></button>
    </div>
  )
}
