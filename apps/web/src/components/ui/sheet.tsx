import type { ComponentProps } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export const Sheet = DialogPrimitive.Root
export const SheetTrigger = DialogPrimitive.Trigger
export const SheetClose = DialogPrimitive.Close

export function SheetContent({ className, side = 'left', children, ...props }: ComponentProps<typeof DialogPrimitive.Content> & { side?: 'left' | 'right' | 'bottom' }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 flex flex-col border-border bg-card shadow-2xl focus:outline-none',
          side === 'left' && 'inset-y-0 left-0 w-[min(88vw,340px)] border-r',
          side === 'right' && 'inset-y-0 right-0 w-[min(88vw,340px)] border-l',
          side === 'bottom' && 'inset-x-0 bottom-0 max-h-[88dvh] rounded-t-2xl border-t',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close aria-label="关闭面板" className="absolute right-3 top-3 grid size-10 place-items-center rounded-md border border-border bg-background text-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="size-4" /></DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function SheetHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 border-b border-border p-4 pr-12', className)} {...props} />
}

function divTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-sm font-semibold', className)} {...props} />
}

export const SheetTitle = divTitle
