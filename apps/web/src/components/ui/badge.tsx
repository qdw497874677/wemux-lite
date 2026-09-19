import type { ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * Badge recipe ported from TailGrids (MIT), incl. the prefix/suffix icon
 * padding matrix. `color` exposes the full TailGrids palette; `variant` keeps
 * the smaller Wemux API and is translated onto it.
 */
const badgeVariants = cva('inline-flex items-center gap-2 rounded-full font-medium [&>svg]:size-3 [&>svg]:text-current', {
  variants: {
    size: {
      sm: 'py-0.5 text-xs',
      md: 'py-0.5 text-sm',
      lg: 'py-1 text-sm',
    },
    color: {
      gray: 'bg-badge-neutral-background text-badge-neutral-text',
      primary: 'bg-badge-primary-background text-badge-primary-text',
      error: 'bg-badge-error-background text-badge-error-text',
      warning: 'bg-badge-warning-background text-badge-warning-text',
      success: 'bg-badge-success-background text-badge-success-text',
      cyan: 'bg-badge-cyan-background text-badge-cyan-text',
      sky: 'bg-badge-sky-background text-badge-sky-text',
      blue: 'bg-badge-blue-background text-badge-blue-text',
      violet: 'bg-badge-violet-background text-badge-violet-text',
      purple: 'bg-badge-purple-background text-badge-purple-text',
      pink: 'bg-badge-pink-background text-badge-pink-text',
      rose: 'bg-badge-rose-background text-badge-rose-text',
      orange: 'bg-badge-orange-background text-badge-orange-text',
    },
    prefixIcon: { true: '', false: '' },
    suffixIcon: { true: '', false: '' },
  },
  compoundVariants: [
    { prefixIcon: false, suffixIcon: false, size: 'sm', className: 'px-2' },
    { prefixIcon: false, suffixIcon: false, size: 'md', className: 'px-2.5' },
    { prefixIcon: false, suffixIcon: false, size: 'lg', className: 'px-3' },
    { prefixIcon: true, suffixIcon: false, size: 'sm', className: 'pr-2 pl-1.5' },
    { prefixIcon: true, suffixIcon: false, size: 'md', className: 'pr-2.5 pl-2' },
    { prefixIcon: true, suffixIcon: false, size: 'lg', className: 'pr-3 pl-2.5' },
    { prefixIcon: false, suffixIcon: true, size: 'sm', className: 'pr-1.5 pl-2' },
    { prefixIcon: false, suffixIcon: true, size: 'md', className: 'pr-2 pl-2.5' },
    { prefixIcon: false, suffixIcon: true, size: 'lg', className: 'pr-2.5 pl-3' },
    { prefixIcon: true, suffixIcon: true, size: 'sm', className: 'px-1.5' },
    { prefixIcon: true, suffixIcon: true, size: 'md', className: 'px-2' },
    { prefixIcon: true, suffixIcon: true, size: 'lg', className: 'px-2.5' },
  ],
  defaultVariants: { size: 'sm', color: 'primary', prefixIcon: false, suffixIcon: false },
})

const legacyVariants = {
  default: 'primary',
  secondary: 'gray',
  success: 'success',
  warning: 'warning',
  danger: 'error',
  outline: 'gray',
} as const

type BadgeColorProps = VariantProps<typeof badgeVariants>

export type BadgeProps = Omit<BadgeColorProps, 'prefixIcon' | 'suffixIcon'> & {
  variant?: keyof typeof legacyVariants
  prefixIcon?: ReactNode
  suffixIcon?: ReactNode
  className?: string
  children?: ReactNode
}

export function Badge({ color, variant, size, prefixIcon, suffixIcon, className, children, ...props }: BadgeProps & { title?: string }) {
  const resolved = color ?? (variant ? legacyVariants[variant] : 'primary')
  const outlined = variant === 'outline'
  return (
    <span
      className={cn(
        badgeVariants({ color: resolved, size, prefixIcon: Boolean(prefixIcon), suffixIcon: Boolean(suffixIcon) }),
        outlined && 'border border-base-200 bg-transparent text-text-100',
        className,
      )}
      {...props}
    >
      {prefixIcon}
      {children}
      {suffixIcon}
    </span>
  )
}