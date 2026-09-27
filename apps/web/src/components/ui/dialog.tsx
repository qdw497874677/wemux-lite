import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Close } from './tailgrids-icons.tsx'
import { cn } from '../../lib/utils.ts'
import { registerShortcut } from '../../lib/shortcuts.ts'

/**
 * Dialog ported from TailGrids (MIT, `modal`/`dialog`): 35rem panel（`max-w-140`），
 * 1.5rem 面板内边距，header/body/footer 自带间距，footer 右对齐。
 * radix owns focus trapping; the surfaces use the TailGrids colour tokens.
 */
function Dialog({ open, defaultOpen, onOpenChange, ...props }: DialogPrimitive.DialogProps) {
  const controlled = open !== undefined
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen ?? false)
  const visible = controlled ? open : internalOpen
  React.useEffect(() => {
    if (!visible) return
    return registerShortcut({ combo: 'Escape', scope: 'dialog', description: '关闭对话框', priority: 100, allowInEditable: true, handler: () => { if (!controlled) setInternalOpen(false); onOpenChange?.(false) } })
  }, [controlled, onOpenChange, visible])
  return <DialogPrimitive.Root data-slot="dialog" open={visible} onOpenChange={next => { if (!controlled) setInternalOpen(next); onOpenChange?.(next) }} {...props} />
}
function DialogTrigger(props: DialogPrimitive.DialogTriggerProps) { return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} /> }
function DialogPortal(props: DialogPrimitive.DialogPortalProps) { return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} /> }
function DialogClose(props: DialogPrimitive.DialogCloseProps) { return <DialogPrimitive.Close data-slot="dialog-close" {...props} /> }

function DialogOverlay({ className, ...props }: DialogPrimitive.DialogOverlayProps) {
  return <DialogPrimitive.Overlay data-slot="dialog-overlay" className={cn('fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=closed]:opacity-0 data-[state=open]:opacity-100', className)} {...props} />
}

function DialogContent({ className, children, onOpenAutoFocus, ...props }: DialogPrimitive.DialogContentProps) {
  // 与上游 react-aria 的 Modal 一致：打开时焦点落在对话框容器本身（tabindex=-1），
  // 而不是自动跳到第一个可聚焦子元素上（那会让“取消”按钮一开场就挂着焦点环）。
  const handleOpenAutoFocus: NonNullable<DialogPrimitive.DialogContentProps['onOpenAutoFocus']> = (event) => {
    onOpenAutoFocus?.(event)
    if (event.defaultPrevented) return
    event.preventDefault()
    ;(event.currentTarget as HTMLElement).focus()
  }
  return <DialogPortal><DialogOverlay /><DialogPrimitive.Content onOpenAutoFocus={handleOpenAutoFocus} tabIndex={-1} data-slot="dialog-content" className={cn('fixed top-1/2 left-1/2 z-50 w-full max-w-140 max-sm:max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-base-100 bg-background-100 p-6 text-title-50 shadow-lg outline-none data-[state=closed]:opacity-0 data-[state=open]:opacity-100', className)} {...props}>{children}<DialogPrimitive.Close className="absolute top-4 right-4 flex size-7 items-center justify-center rounded-md text-text-100 opacity-70 outline-none transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-primary-500 disabled:pointer-events-none [&>svg]:size-5"><Close /><span className="sr-only">关闭</span></DialogPrimitive.Close></DialogPrimitive.Content></DialogPortal>
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-1.5 text-left', className)} {...props} />
}

function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-body" className={cn('py-4 text-sm text-text-100', className)} {...props} />
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-footer" className={cn('flex flex-col-reverse gap-2 pt-4 sm:flex-row sm:justify-end', className)} {...props} />
}

function DialogTitle({ className, ...props }: DialogPrimitive.DialogTitleProps) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn('text-lg font-semibold leading-none text-title-50', className)} {...props} />
}

function DialogDescription({ className, ...props }: DialogPrimitive.DialogDescriptionProps) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn('text-sm text-text-50', className)} {...props} />
}

export { Dialog, DialogPortal, DialogOverlay, DialogClose, DialogTrigger, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle, DialogDescription }