import type { HTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/** Separator recipe ported from TailGrids (MIT). 类名与上游逐字一致：
 *  上游用原始变量 `bg-(--border-color-base-200)` 而不是主题别名，`h-[1px]`
 *  而不是 `h-px`；两者计算值相同，但保留字面量能让类名级比对也归零。 */
const separatorVariants = cva('shrink-0 bg-(--border-color-base-200)', {
  variants: {
    orientation: {
      horizontal: 'h-[1px] w-full',
      vertical: 'h-full w-[1px]',
    },
  },
  defaultVariants: { orientation: 'horizontal' },
})

export type SeparatorProps = HTMLAttributes<HTMLElement> & VariantProps<typeof separatorVariants>

export function Separator({ className, orientation = 'horizontal', ...props }: SeparatorProps) {
  // 垂直方向没有对应的原生元素，退化为 role="separator" 的 div。
  if (orientation === 'vertical') {
    return <div role="separator" aria-orientation="vertical" className={cn(separatorVariants({ orientation }), className)} {...props} />
  }
  // 与上游一致：水平分隔线用原生 <hr>（自带 separator 语义，无需 ARIA）。
  // 注意：Tailwind preflight 给 <hr> 一条 `color: inherit` 的 1px 上边框，上游并未清除，
  // 所以上游的分隔线实际是“currentColor 细线 + 1px 背景色”两层；这里的类名刻意与上游逐字对齐，
  // 避免出现只有我们才有的 border-0。
  return <hr className={cn(separatorVariants({ orientation }), className)} {...props} />
}