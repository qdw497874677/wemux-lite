import type { ComponentProps, ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Button } from './button.tsx'
import { CheckCircle1, Close, Envelope1, InfoCircle, XmarkCircle } from './tailgrids-icons.tsx'
import { cn } from '@/lib/utils'

/**
 * Toast 逐条对照 TailGrids（MIT, github.com/TailGrids）的 `toast` 复刻：
 * 卡片本体只负责表面与排版，不承担定位；图标 chip 是整张卡上唯一的彩色面。
 * 与上游的两点差异（有意保留）：关闭按钮接 `onClose` 以便 Wemux 真正关闭提示，
 * 卡片带 `role="status"` 供读屏播报。
 */
const iconWrapperVariants = cva('grid size-9 place-items-center rounded-md [&>svg]:size-6 [&>svg]:text-current', {
  variants: {
    variant: {
      default: 'bg-primary-500/10 text-primary-500',
      info: 'bg-info-500/10 text-info-500',
      success: 'bg-success-500/10 text-success-500',
      warning: 'bg-warning-500/10 text-warning-500',
      error: 'bg-error-500/10 text-error-500',
    },
  },
  defaultVariants: { variant: 'default' },
})

const icons = { default: Envelope1, success: CheckCircle1, warning: InfoCircle, info: InfoCircle, error: XmarkCircle } as const

/** 字符串 = 单行通知；对象 = 带标题的详细通知（上游用同一分支控制排版与关闭按钮位置）。 */
export type ToastMessage = string | { title: string; description: string }

export type ToastProps = VariantProps<typeof iconWrapperVariants> & {
  message: ToastMessage
  icon?: ReactNode
  undoAction?: () => void
  hideIcon?: boolean
  onClose?: () => void
  className?: string
  children?: ReactNode
}

export function Toast({ variant = 'default', message, icon, undoAction, hideIcon, onClose, className, children }: ToastProps) {
  const detailed = typeof message === 'object'
  const Icon = icons[variant ?? 'default']
  return (
    <div
      role="status"
      className={cn(
        'flex max-w-112.5 min-w-96.25 items-center gap-3 rounded-lg border border-base-200 bg-background-100 p-3 shadow-sm',
        detailed && 'relative items-start',
        hideIcon && 'py-2',
        className,
      )}
    >
      {!hideIcon && <div className={cn(iconWrapperVariants({ variant }))}>{icon ?? <Icon aria-hidden />}</div>}
      <div className={cn(!detailed && 'contents', detailed && hideIcon && 'ml-1')}>
        {detailed && <h4 className="mb-1.5 text-lg font-semibold text-title-50">{message.title}</h4>}
        <p className={cn(detailed ? 'text-sm text-text-100' : 'text-base font-medium text-title-50', !detailed && hideIcon && 'ml-1')}>
          {detailed ? message.description : message}
        </p>
        {!detailed && undoAction && (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-500 transition hover:text-primary-600"
            onClick={undoAction}
          >
            撤销
          </button>
        )}
        {children}
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          className={cn(!undoAction && 'ml-auto', detailed && 'absolute top-1 right-1')}
          onClick={onClose}
        >
          <span className="sr-only">关闭通知</span>
          <Close />
        </Button>
      </div>
    </div>
  )
}

/**
 * Toast 的定位容器。上游 React 包只有卡片本体，示例页面各自把卡片钉在右下角；
 * Wemux 把这段固定定位单独收成一层，保证手机上贴安全区、桌面贴右下角。
 */
export function ToastRegion({ className, children, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'pointer-events-none fixed inset-x-3 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[100] mx-auto flex w-[calc(100%-1.5rem)] max-w-sm flex-col gap-3 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:mx-0 sm:w-auto [&>*]:pointer-events-auto',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}