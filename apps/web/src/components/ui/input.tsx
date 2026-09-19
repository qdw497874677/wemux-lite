import type { InputHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * Input recipe ported from TailGrids (MIT). Colour, radius and the 4px focus
 * ring come from the `--color-input-*` / border tokens in styles.css.
 * `state` mirrors the component's error/success contract; `aria-invalid`
 * still drives the error surface for forms that do not pass a state.
 *
 * 基础类与上游 input.tsx 逐字一致（含 `max-w-full`，**不含 `w-full`**）：上游让
 * 父级 flex/grid 去拉伸控件，宽度属于布局决定，不是控件的默认值。把 Input
 * 放在块级/行内父级里的调用点因此要自己写 `w-full`。
 */
const inputVariants = cva(
  'ring-focus peer max-w-full rounded-lg border bg-input-background px-4 py-2.5 text-title-50 outline-none placeholder:text-input-placeholder-text focus:ring-4 disabled:cursor-not-allowed disabled:border-base-100 disabled:text-input-disabled-text disabled:placeholder:text-input-disabled-text data-[invalid]:border-input-error-focus-border data-[invalid]:ring-input-error-focus-border/20',
  {
    variants: {
      state: {
        default:
          'border-base-300 focus:border-input-primary-focus-border focus:ring-input-primary-focus-border/20 aria-invalid:border-input-error-focus-border aria-invalid:ring-input-error-focus-border/20',
        error: 'border-input-error-focus-border focus:ring-input-error-focus-border/20',
        success: 'border-input-success-focus-border focus:ring-input-success-focus-border/20',
      },
    },
    defaultVariants: { state: 'default' },
  },
)

export type InputProps = InputHTMLAttributes<HTMLInputElement> & VariantProps<typeof inputVariants>

export function Input({ className, state, ...props }: InputProps) {
  return <input className={cn(inputVariants({ state }), className)} {...props} />
}