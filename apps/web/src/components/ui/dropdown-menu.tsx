import type { ComponentProps } from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Check, ChevronRight } from './tailgrids-icons.tsx'
import { cn } from '@/lib/utils'

/**
 * Dropdown menu ported from TailGrids (MIT, `dropdown`): `dropdown-background`
 * popover, `dropdown-hover-background` highlight, 0.75rem radii. radix keeps
 * the typeahead and focus return behaviour.
 */
export const DropdownMenu = DropdownMenuPrimitive.Root
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

export function DropdownMenuContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn('z-50 min-w-40 overflow-clip rounded-xl bg-dropdown-background shadow-md outline-none', className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

export function DropdownMenuItem({ className, inset, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Item> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        'ring-focus relative flex cursor-default items-center gap-3 rounded-md px-1.5 py-1 text-sm text-text-50 outline-none select-none',
        'transition-colors focus:bg-dropdown-hover-background focus:text-title-50 data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        '[&>svg]:size-4 [&>svg]:shrink-0',
        inset && 'pl-8',
        className,
      )}
      {...props}
    />
  )
}

export function DropdownMenuCheckboxItem({ className, children, checked, ...props }: ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        'ring-focus relative flex cursor-default items-center gap-3 rounded-md py-1 pr-1.5 pl-8 text-sm text-text-50 outline-none select-none',
        'transition-colors focus:bg-dropdown-hover-background focus:text-title-50 data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2.5 grid size-4 place-items-center">
        <DropdownMenuPrimitive.ItemIndicator><Check className="size-4" /></DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator className={cn('my-1 h-px bg-dropdown-divider', className)} {...props} />
}

export function DropdownMenuSubTrigger({ className, children, ...props }: ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger className={cn('ring-focus flex cursor-default items-center gap-3 rounded-md px-1.5 py-1 text-sm text-text-50 outline-none select-none focus:bg-dropdown-hover-background focus:text-title-50', className)} {...props}>
      {children}
      <ChevronRight className="ml-auto size-4" />
    </DropdownMenuPrimitive.SubTrigger>
  )
}

export const DropdownMenuSub = DropdownMenuPrimitive.Sub