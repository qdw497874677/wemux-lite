import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/** Label recipe ported from TailGrids (MIT)：上游把表单标签叫 FieldLabel，
 *  `text-sm font-medium text-input-label-text`，我们统一从这个 Label 出。 */
export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-sm font-medium text-input-label-text select-none cursor-pointer', className)} {...props} />
}

/** Field wraps a control with its label, description and error text.
 *  行间节奏沿用上游 FieldGroup 的 `flex flex-col gap-6`（未加 `w-full`：
 *  `w-full` 会变成真实的宽度约束，在栅格布局里把单元格挤到容器满宽，
 *  而上游的对照组是全靠内容宽度定尺寸的）。 */
export function Field({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex min-w-0 flex-col gap-6', className)} {...props} />
}

/** 说明文字：上游 FieldDescription 渲染成 <span>，颜色是 text-50。 */
export function FieldDescription({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('text-sm font-normal text-text-50', className)} {...props} />
}

export function FieldError({ className, ...props }: ComponentProps<'p'>) {
  return <p role="alert" className={cn('text-sm font-normal text-input-error', className)} {...props} />
}