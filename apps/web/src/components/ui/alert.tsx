import type { ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { CheckCircle1, InfoCircle, InfoTriangle, Xmark } from './tailgrids-icons.tsx'
import { cn } from '@/lib/utils'

/**
 * Alert ported from TailGrids (MIT): five tones, each with its own background,
 * border and icon chip colour, all from the `--color-alert-*` tokens.
 */
const alertVariants = cva('relative flex w-full max-w-4xl items-start gap-3 rounded-lg border px-5 py-4', {
  variants: {
    tone: {
      default: 'border-alert-default-border bg-alert-default-background',
      info: 'border-alert-info-border bg-alert-info-background',
      success: 'border-alert-success-border bg-alert-success-background',
      warning: 'border-alert-warning-border bg-alert-warning-background',
      danger: 'border-alert-danger-border bg-alert-danger-background',
    },
  },
  defaultVariants: { tone: 'default' },
})

const chipVariants = cva('flex size-7 shrink-0 items-center justify-center rounded-lg text-white-100 [&>svg]:size-4', {
  variants: {
    tone: {
      default: 'bg-alert-default-icon-background',
      info: 'bg-alert-info-icon-background',
      success: 'bg-alert-success-icon-background',
      warning: 'bg-alert-warning-icon-background',
      danger: 'bg-alert-danger-icon-background',
    },
  },
  defaultVariants: { tone: 'default' },
})

const titleVariants = cva('font-semibold leading-6 tracking-[-0.2px]', {
  variants: {
    tone: {
      default: 'text-alert-default-title',
      info: 'text-alert-info-title',
      success: 'text-alert-success-title',
      warning: 'text-alert-warning-title',
      danger: 'text-alert-danger-title',
    },
  },
  defaultVariants: { tone: 'default' },
})

// 图标与上游 @tailgrids/icons 逐字对齐：success=CheckCircle1、warning=InfoTriangle、
// danger=Xmark、info/default=InfoCircle（lucide 的圆/三角图标造型与上游不同）。
const defaultIcons = {
  default: InfoCircle,
  info: InfoCircle,
  success: CheckCircle1,
  warning: InfoTriangle,
  danger: Xmark,
} as const

export type AlertProps = VariantProps<typeof alertVariants> & {
  title?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  className?: string
  children?: ReactNode
}

export function Alert({ tone = 'default', title, icon, action, className, children }: AlertProps) {
  const Icon = defaultIcons[tone ?? 'default']
  return (
    <div role="alert" className={cn(alertVariants({ tone }), className)}>
      <span className={cn(chipVariants({ tone }))}>{icon ?? <Icon aria-hidden />}</span>
      <div className="flex flex-1 flex-col items-start gap-1">
        {title && <h4 className={cn(titleVariants({ tone }))}>{title}</h4>}
        {children && <div className="text-sm leading-5 tracking-[-0.2px] text-text-100">{children}</div>}
      </div>
      {action}
    </div>
  )
}