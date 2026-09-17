import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

function Dialog(props: DialogPrimitive.DialogProps) { return <DialogPrimitive.Root data-slot="dialog" {...props} /> }
function DialogTrigger(props: DialogPrimitive.DialogTriggerProps) { return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} /> }
function DialogPortal(props: DialogPrimitive.DialogPortalProps) { return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} /> }
function DialogClose(props: DialogPrimitive.DialogCloseProps) { return <DialogPrimitive.Close data-slot="dialog-close" {...props} /> }

function DialogOverlay({ className, ...props }: DialogPrimitive.DialogOverlayProps) {
  return <DialogPrimitive.Overlay data-slot="dialog-overlay" className={cn('fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=closed]:opacity-0 data-[state=open]:opacity-100', className)} {...props} />
}

function DialogContent({ className, children, ...props }: DialogPrimitive.DialogContentProps) {
  return <DialogPortal><DialogOverlay /><DialogPrimitive.Content data-slot="dialog-content" className={cn('fixed top-1/2 left-1/2 z-50 grid w-full max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl border border-white/10 bg-card p-6 shadow-2xl outline-none data-[state=closed]:opacity-0 data-[state=open]:opacity-100', className)} {...props}>{children}<DialogPrimitive.Close className="absolute top-4 right-4 rounded-lg p-1 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"><X className="size-4" /><span className="sr-only">关闭</span></DialogPrimitive.Close></DialogPrimitive.Content></DialogPortal>
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-1.5 text-left', className)} {...props} />
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-footer" className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3', className)} {...props} />
}

function DialogTitle({ className, ...props }: DialogPrimitive.DialogTitleProps) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn('text-base font-semibold leading-none tracking-tight', className)} {...props} />
}

function DialogDescription({ className, ...props }: DialogPrimitive.DialogDescriptionProps) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn('text-sm leading-5 text-muted-foreground', className)} {...props} />
}

export { Dialog, DialogPortal, DialogOverlay, DialogClose, DialogTrigger, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription }
