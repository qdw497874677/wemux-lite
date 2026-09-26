import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { cn } from '../../lib/utils.ts'

function Popover(props: PopoverPrimitive.PopoverProps) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger(props: PopoverPrimitive.PopoverTriggerProps) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({ className, align = 'start', sideOffset = 8, ...props }: PopoverPrimitive.PopoverContentProps) {
  return <PopoverPrimitive.Portal><PopoverPrimitive.Content data-slot="popover-content" align={align} sideOffset={sideOffset} className={cn('z-50 max-h-72 w-72 overflow-auto rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none', className)} {...props} /></PopoverPrimitive.Portal>
}

export { Popover, PopoverTrigger, PopoverContent }
