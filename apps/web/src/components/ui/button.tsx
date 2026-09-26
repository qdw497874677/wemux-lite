/* Derived from pingdotgg/t3code (MIT). */
import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '../../lib/utils.ts'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-3 rounded-lg font-medium transition focus:ring-3 disabled:pointer-events-none [&>svg]:text-current outline-none ring-focus whitespace-nowrap [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-button-primary-background bg-button-primary-background text-button-primary-text shadow-xs hover:bg-button-primary-hover-background',
        secondary: 'border-transparent bg-secondary text-secondary-foreground hover:bg-accent',
        outline: '[--control-icon-color:var(--contrast-muted-foreground)] border-button-outline-border bg-button-outline-background text-button-outline-text shadow-xs hover:bg-button-outline-hover-background hover:text-button-outline-hover-text',
        ghost: '[--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-foreground hover:bg-accent',
        destructive: 'border-button-error-background bg-button-error-background text-button-error-text shadow-xs hover:bg-button-error-hover-background',
        success: 'border-button-success-background bg-button-success-background text-button-success-text shadow-xs hover:bg-button-success-hover-background',
        glass: 'surface-glass [--control-icon-color:var(--contrast-muted-foreground)] rounded-full border-border/60 text-foreground shadow-sm',
        link: 'border-transparent text-foreground underline-offset-4 hover:underline',
        'warning-outline': 'border-warning-border bg-warning-surface text-warning-foreground hover:bg-warning/20',
      },
      appearance: { fill: '', outline: '' },
      size: {
        xs: 'h-7 gap-1 px-2 text-xs',
        sm: 'h-8 gap-1.5 px-2.5 text-sm sm:h-7',
        default: 'h-9 px-3 text-sm sm:h-8',
        lg: 'h-10 px-3.5 sm:h-9',
        icon: 'size-9 p-0 sm:size-8',
        'icon-xs': 'size-7 p-0 sm:size-6',
        'icon-sm': 'size-8 p-0 sm:size-7',
        'icon-lg': 'size-10 p-0 sm:size-9',
      },
    },
    compoundVariants: [
      { variant: 'default', appearance: 'outline', className: 'border-button-outline-border bg-button-outline-background text-button-outline-text hover:bg-button-outline-hover-background hover:text-button-outline-hover-text' },
      { variant: 'destructive', appearance: 'outline', className: 'border-button-error-outline-border bg-button-error-outline-background text-button-error-outline-text hover:bg-button-error-outline-hover-background hover:text-button-error-outline-hover-text' },
      { variant: 'success', appearance: 'outline', className: 'border-button-success-outline-border bg-button-success-outline-background text-button-success-outline-text hover:bg-button-success-outline-hover-background hover:text-button-success-outline-hover-text' },
    ],
    defaultVariants: { variant: 'default', appearance: 'fill', size: 'default' },
  },
)

export type ButtonProps = useRender.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & {
  iconOnly?: boolean
}

const iconSizeBySize = {
  xs: 'icon-xs', sm: 'icon-sm', default: 'icon', lg: 'icon-lg',
  icon: 'icon', 'icon-xs': 'icon-xs', 'icon-sm': 'icon-sm', 'icon-lg': 'icon-lg',
} as const

export function Button({ className, variant, appearance, size, iconOnly, render, ...props }: ButtonProps) {
  const resolvedSize = iconOnly ? iconSizeBySize[size ?? 'default'] : size
  const defaultProps = {
    className: cn(buttonVariants({ variant, appearance, size: resolvedSize }), className),
    'data-slot': 'button',
    type: render ? undefined : ('button' as React.ButtonHTMLAttributes<HTMLButtonElement>['type']),
  }
  return useRender({ defaultTagName: 'button', props: mergeProps<'button'>(defaultProps, props), render })
}

export { buttonVariants }
