/* Derived from pingdotgg/t3code (MIT). */
import { useRender } from '@base-ui/react/use-render'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'

const badgeVariants = cva(
  'inline-flex items-center gap-2 rounded-full font-medium [&>svg]:size-3 [&>svg]:text-current',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-error text-white',
        danger: 'border-transparent bg-error text-white',
        success: 'border-transparent bg-success text-white',
        warning: 'border-transparent bg-warning text-black',
        outline: 'border-border text-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export type BadgeProps = useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & {
  prefixIcon?: ReactNode
}

export function Badge({ className, variant, prefixIcon, children, render, ...props }: BadgeProps) {
  return useRender({
    defaultTagName: 'span',
    props: { ...props, className: cn(badgeVariants({ variant }), className), children: <>{prefixIcon}{children}</>, 'data-slot': 'badge' },
    render,
  })
}

export { badgeVariants }
