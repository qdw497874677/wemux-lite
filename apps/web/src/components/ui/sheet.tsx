/* Derived from pingdotgg/t3code (MIT). */
import { Dialog as SheetPrimitive } from '@base-ui/react/dialog'
import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '../../lib/utils.ts'
import { Close } from './tailgrids-icons.tsx'

export const Sheet = SheetPrimitive.Root

export function SheetTrigger({ asChild, children, ...props }: SheetPrimitive.Trigger.Props & { asChild?: boolean }) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" render={asChild ? children as React.ReactElement : undefined} {...props}>{asChild ? undefined : children}</SheetPrimitive.Trigger>
}

export function SheetClose({ asChild, children, ...props }: SheetPrimitive.Close.Props & { asChild?: boolean }) {
  return <SheetPrimitive.Close data-slot="sheet-close" render={asChild ? children as React.ReactElement : undefined} {...props}>{asChild ? undefined : children}</SheetPrimitive.Close>
}

export function SheetPortal(props: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

export function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      className={cn('fixed inset-0 z-[calc(var(--z-sheet)-1)] bg-black/60 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0', className)}
      data-slot="sheet-overlay"
      {...props}
    />
  )
}

const sheetVariants = cva(
  'fixed z-50 flex flex-col gap-4 border-base-100 bg-background-100 p-6 shadow-lg outline-none text-contrast-foreground transition-[transform,opacity] duration-200 data-[ending-style]:opacity-95 data-[starting-style]:opacity-95',
  {
    variants: {
      side: {
        top: 'inset-x-0 top-0 border-b data-[ending-style]:-translate-y-full data-[starting-style]:-translate-y-full',
        bottom: 'inset-x-0 bottom-0 border-t data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full',
        left: 'inset-y-0 left-0 h-full w-3/4 border-r data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full sm:max-w-sm',
        right: 'inset-y-0 right-0 h-full w-3/4 border-l data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full sm:max-w-sm',
      },

    },
    defaultVariants: { side: 'right' },
  },
)

export type SheetContentProps = SheetPrimitive.Popup.Props & VariantProps<typeof sheetVariants> & {
  showCloseButton?: boolean
}

export function SheetContent({ className, children, side, showCloseButton = true, ...props }: SheetContentProps) {
  const isLeft = side === 'left'
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Viewport className="fixed inset-0 z-[var(--z-sheet)] pointer-events-none" data-slot="sheet-viewport">
        <SheetPrimitive.Popup className={cn(sheetVariants({ side }), 'pointer-events-auto', className)} data-side={isLeft ? 'left' : side} data-slot="sheet-content" {...props}>
          {children}
          {showCloseButton ? (
            <SheetPrimitive.Close className="absolute top-4 right-4 flex size-7 items-center justify-center rounded-md text-text-100 opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&>svg]:size-5">
              <Close />
              <span className="sr-only">关闭</span>
            </SheetPrimitive.Close>
          ) : null}
        </SheetPrimitive.Popup>
      </SheetPrimitive.Viewport>
    </SheetPortal>
  )
}

export function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 text-center sm:text-left', className)} data-slot="sheet-header" {...props} />
}

export function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('mt-auto flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} data-slot="sheet-footer" {...props} />
}

export function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return <SheetPrimitive.Title className={cn('font-semibold text-lg text-contrast-foreground', className)} data-slot="sheet-title" {...props} />
}

export function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return <SheetPrimitive.Description className={cn('text-contrast-muted-foreground text-sm', className)} data-slot="sheet-description" {...props} />
}
