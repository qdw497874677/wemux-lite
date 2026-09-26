/* Derived from pingdotgg/t3code (MIT). */
import { Separator as SeparatorPrimitive } from '@base-ui/react/separator'
import { cn } from '../../lib/utils.ts'

export function Separator({ className, orientation = 'horizontal', ...props }: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      className={cn(
        'shrink-0 bg-(--border-color-base-200)',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      data-slot="separator-root"
      orientation={orientation}
      {...props}
    />
  )
}
