import type { HTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary/15 text-primary',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      success: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
      warning: 'border-amber-500/20 bg-amber-500/10 text-amber-300',
      danger: 'border-red-500/25 bg-red-500/10 text-red-400',
      outline: 'border-border text-muted-foreground',
    },
  },
  defaultVariants: { variant: 'default' },
})

type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
