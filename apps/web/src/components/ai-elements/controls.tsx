import { Controls as ControlsPrimitive } from '@xyflow/react'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils.ts'

export type ControlsProps = ComponentProps<typeof ControlsPrimitive>

export function Controls({ className, ...props }: ControlsProps) {
  return <ControlsPrimitive className={cn('overflow-hidden rounded-lg border border-border bg-background/95 p-1 shadow-lg backdrop-blur [&>button]:rounded-md [&>button]:border-0! [&>button]:bg-transparent! [&>button:hover]:bg-accent!', className)} {...props} />
}
