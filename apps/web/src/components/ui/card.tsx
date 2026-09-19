import type { ComponentProps } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * Card ported from TailGrids (MIT): Card / CardHeader / CardTitle /
 * CardDescription / CardAction / CardContent / CardFooter.
 * The default surface is the TailGrids literal (`bg-card-background-50`, no
 * border, no shadow). `variant="surface"` is a Wemux superset that adds the
 * bordered panel look for pages which embed a card inside another container.
 */
const cardVariants = cva('flex w-full flex-col gap-3 rounded-2xl md:min-w-sm', {
  variants: {
    variant: {
      plain: 'bg-card-background-50',
      surface: 'border border-base-100 bg-card-background-100 shadow-sm',
    },
  },
  defaultVariants: { variant: 'plain' },
})

export type CardProps = ComponentProps<'div'> & VariantProps<typeof cardVariants>

export function Card({ className, variant, ...props }: CardProps) {
  return <div className={cn(cardVariants({ variant }), className)} {...props} />
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('relative w-full px-5 pt-5', className)} {...props} />
}

export function CardTitle({ className, ...props }: ComponentProps<'div'>) {
  // 上游 CardTitle 是 div（排版靠 class，标题语义由页面给），这里保持同结构以便逐元素对齐。
  return <div className={cn('text-xl leading-7 font-semibold tracking-[-0.2px] text-title-50 md:text-2xl', className)} {...props} />
}

export function CardDescription({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mt-0.5 text-base leading-6 tracking-[-0.2px] text-text-100', className)} {...props} />
}

export function CardAction({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('absolute top-5 right-5 text-text-50', className)} {...props} />
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-5 text-text-100', className)} {...props} />
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-5 pb-5', className)} {...props} />
}