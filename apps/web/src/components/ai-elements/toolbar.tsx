import { NodeToolbar, Position } from '@xyflow/react'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils.ts'

export type ToolbarProps = ComponentProps<typeof NodeToolbar>

export function Toolbar({ className, position = Position.Bottom, ...props }: ToolbarProps) {
  return <NodeToolbar className={cn('flex items-center gap-1 rounded-lg border border-border bg-background/95 p-1 shadow-xl backdrop-blur', className)} position={position} {...props} />
}
