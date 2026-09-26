/* Derived from pingdotgg/t3code (MIT). */
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { cn } from '../../lib/utils.ts'

export function ScrollArea({ children, className, ...props }: ScrollAreaPrimitive.Root.Props) {
  return (
    <ScrollAreaPrimitive.Root className={cn('relative min-h-0', className)} data-slot="scroll-area" {...props}>
      <ScrollAreaPrimitive.Viewport className="h-full w-full overscroll-contain rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring/50" data-slot="scroll-area-viewport">
        <ScrollAreaPrimitive.Content>{children}</ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

export function ScrollBar({ className, orientation = 'vertical', ...props }: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      className={cn(
        'group/scrollbar flex touch-none select-none p-0.5 opacity-0 transition-opacity delay-300 duration-100 data-[hovering]:opacity-100 data-[scrolling]:opacity-100 data-[orientation=horizontal]:h-2.5 data-[orientation=horizontal]:flex-col data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2.5',
        className,
      )}
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border transition-colors before:absolute before:inset-[-4px] group-hover/scrollbar:bg-muted-foreground/70" data-slot="scroll-area-thumb" />
    </ScrollAreaPrimitive.Scrollbar>
  )
}
