import type { ComponentProps } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Close } from './tailgrids-icons.tsx'
import { cn } from '@/lib/utils'

/**
 * Sheet kept as a radix dialog with TailGrids surfaces (`drawer` on the source
 * side): 1px base border on the splitting edge, `background-100` panel body.
 */
export const Sheet = DialogPrimitive.Root
export const SheetTrigger = DialogPrimitive.Trigger
export const SheetClose = DialogPrimitive.Close

export function SheetContent({ className, side = 'left', children, onOpenAutoFocus, ...props }: ComponentProps<typeof DialogPrimitive.Content> & { side?: 'left' | 'right' | 'bottom' }) {
  // 与上游 react-aria 的 Drawer/Modal 一致：打开时焦点落在面板容器本身，
  // 而不是自动跳到第一个可聚焦子元素（关闭按钮）上。
  const handleOpenAutoFocus: NonNullable<ComponentProps<typeof DialogPrimitive.Content>['onOpenAutoFocus']> = (event) => {
    onOpenAutoFocus?.(event)
    if (event.defaultPrevented) return
    event.preventDefault()
    ;(event.currentTarget as HTMLElement).focus()
  }
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
      <DialogPrimitive.Content
        onOpenAutoFocus={handleOpenAutoFocus}
        tabIndex={-1}
        className={cn(
          'fixed z-50 flex flex-col gap-4 border-base-100 bg-background-100 p-6 shadow-lg outline-none',
          side === 'left' && 'inset-y-0 left-0 h-full w-[min(88vw,20rem)] border-r',
          side === 'right' && 'inset-y-0 right-0 h-full w-[min(88vw,20rem)] border-l',
          side === 'bottom' && 'inset-x-0 bottom-0 max-h-[88dvh] border-t',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close aria-label="关闭面板" className="absolute top-4 right-4 flex size-7 items-center justify-center rounded-md text-text-100 opacity-70 outline-none transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-primary-500 disabled:pointer-events-none [&>svg]:size-5"><Close /><span className="sr-only">关闭</span></DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function SheetHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="sheet-header" className={cn('flex flex-col gap-1.5 text-left', className)} {...props} />
}

function divTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="sheet-title" className={cn('text-lg font-semibold leading-none text-title-50', className)} {...props} />
}

export const SheetTitle = divTitle