import { Panel as PanelPrimitive } from '@xyflow/react'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils.ts'

export type PanelProps = ComponentProps<typeof PanelPrimitive>

export function Panel({ className, ...props }: PanelProps) {
  return <PanelPrimitive className={cn('m-4 overflow-hidden rounded-lg border border-border bg-background/95 p-1 shadow-lg backdrop-blur', className)} {...props} />
}
