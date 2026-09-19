import type { ComponentProps } from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp } from './tailgrids-icons.tsx'
import { cn } from '@/lib/utils'

/**
 * Select ported from TailGrids (MIT): 2.5rem trigger on the input surface,
 * `dropdown-background` popover and a check indicator column. radix keeps the
 * listbox semantics and scroll buttons.
 */
export const Select = SelectPrimitive.Root
export const SelectValue = SelectPrimitive.Value

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        // 触发器几何与配色沿用 TailGrids 的 outline 按钮配方（上游 SelectTrigger
        // 就是 outline Button + `p-2 pl-2.5 text-sm justify-between`），
        // 因此高度、内边距、边框与颜色和上游选择器保持一致。
        'ring-focus flex w-full items-center justify-between gap-3 rounded-lg border border-button-outline-border bg-button-outline-background p-2 pl-2.5 text-sm font-medium text-button-outline-text outline-none',
        'transition-colors hover:bg-button-outline-hover-background hover:text-button-outline-hover-text focus-visible:ring-3 focus-visible:ring-button-outline-focus-ring',
        'disabled:cursor-not-allowed disabled:opacity-55 data-[placeholder]:text-text-100 [&>span]:truncate',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild><ChevronDown className="size-4 shrink-0 text-text-100" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

export function SelectContent({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content className={cn('relative z-[70] max-h-80 min-w-[8rem] overflow-hidden rounded-xl border border-base-100 bg-dropdown-background text-title-50 shadow-md', className)} position="popper" {...props}>
        <SelectPrimitive.ScrollUpButton className="flex items-center justify-center py-1 text-text-100"><ChevronUp className="size-4" /></SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex items-center justify-center py-1 text-text-100"><ChevronDown className="size-4" /></SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'ring-focus relative flex w-full cursor-default items-center gap-3 rounded-md py-1.5 pr-2.5 pl-8 text-sm text-text-50 outline-none select-none',
        'transition-colors focus:bg-dropdown-hover-background focus:text-title-50 data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2.5 grid size-4 place-items-center"><SelectPrimitive.ItemIndicator><Check className="size-4" /></SelectPrimitive.ItemIndicator></span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}