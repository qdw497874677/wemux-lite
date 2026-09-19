import type { InputHTMLAttributes, ReactNode } from 'react'
import { useRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * CheckboxCheck — 逐字取自上游 checkbox.tsx 的内联勾选图标（MIT）：
 * viewBox 14、strokeWidth 1.94437、圆角端点，与上游同一图形。
 * 换成通用图标集（lucide 等）会引入肉眼不可见的反锯齿差异。
 */
function CheckboxCheck() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 14 14"
      aria-hidden
      className="stroke-checkbox-checked-icon-color"
    >
      <path
        d="M11.667 3.5L5.25 9.917 2.333 7"
        stroke="currentColor"
        strokeWidth={1.94437}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Checkbox ported from TailGrids (MIT). The anatomy mirrors the reference: a
 * `group` wrapper, a visually hidden native input carrying `peer` state, and a
 * styled box that draws the box surface plus the tick. TailGrids builds the tick
 * visibility with `[&>svg]:hidden` / `peer-checked:[&>svg]:block`, which keeps
 * everything driven by the input alone.
 *
 * Superset on purpose: upstream has no label, callers compose it themselves,
 * while we accept `label`/`description` and lay them out next to the box.
 */
const box = {
  sm: 'size-4 rounded [&>svg]:size-3',
  md: 'size-5 rounded-md [&>svg]:size-3.5',
} as const

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> & {
  size?: keyof typeof box
  label?: ReactNode
  description?: ReactNode
}

export function Checkbox({ size = 'md', label, description, className, disabled, ...props }: CheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const toggle = () => {
    if (inputRef.current && !disabled) inputRef.current.click()
  }

  return (
    <div className={cn('group inline-flex select-none', (label || description) && 'items-start gap-3', className)}>
      <input ref={inputRef} type="checkbox" disabled={disabled} className="peer sr-only" {...props} />
      <div
        aria-hidden
        onClick={toggle}
        className={cn(
          'grid place-items-center border border-base-200 bg-checkbox-background transition',
          '[&>svg]:hidden [&>svg]:text-checkbox-checked-icon-color peer-checked:[&>svg]:block peer-disabled:[&>svg]:text-base-50',
          'peer-checked:border-checkbox-checked-border peer-checked:bg-checkbox-checked-background',
          'group-hover:border-checkbox-checked-border peer-focus:border-primary-300 peer-focus:ring-4 peer-focus:ring-checkbox-checked-border/20',
          'peer-disabled:border-base-50',
          !disabled && 'cursor-pointer',
          box[size],
        )}
      >
        <CheckboxCheck />
      </div>
      {(label || description) && (
        <span onClick={toggle} className={cn('grid gap-0.5', !disabled && 'cursor-pointer')}>
          {label && <span className="text-sm font-medium text-title-50">{label}</span>}
          {description && <span className="text-xs leading-5 text-text-100">{description}</span>}
        </span>
      )}
    </div>
  )
}