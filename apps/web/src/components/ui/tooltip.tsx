import type { ComponentProps } from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '@/lib/utils'

/**
 * Tooltip ported from TailGrids (MIT): `tooltip-border` / `tooltip-text` pair,
 * 0.75rem radius and a soft shadow. radix keeps the hover/focus arbitration.
 *
 * 已知差异（有意保留，见 docs/acceptance/component-library-tailgrids.md）：
 * 上游基于 floating-ui，气泡边缘还有一个 FloatingArrow 小箭头。该箭头在
 * TailGrids 上游实现里被放在气泡的反侧、且 20x20 的路径被塞进 18x18 视口，
 * 实际只渲染出一条约 5px 的窄条，深色主题下与页面背景同色不可见。
 * radix 的 Arrow 会把气泡再推开一个箭头高度（18px），比复刻这条不可见窄条
 * 更偏离上游的真实观感，因此这里不渲染箭头。
 */
export const TooltipProvider = TooltipPrimitive.Provider
export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export function TooltipContent({ className, sideOffset = 10, ...props }: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        // 上游 offset(10)：气泡到触发元素的间距。
        sideOffset={sideOffset}
        // `hidden sm:block` 与上游一致：窄屏不弹气泡（触屏没有 hover）。
        className={cn('hidden sm:block z-50 max-w-xs rounded-lg border border-tooltip-border bg-background-100 px-3 py-2 text-sm font-medium text-tooltip-text shadow-md select-none', className)}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
}