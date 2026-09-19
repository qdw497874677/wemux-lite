import type { TextareaHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/** Textarea recipe ported from TailGrids (MIT); see input.tsx for the shared state contract. */
const textareaVariants = cva(
  'ring-focus peer w-full rounded-lg border bg-input-background px-4 py-3.5 text-title-50 outline-none placeholder:text-input-placeholder-text focus:ring-4 disabled:cursor-not-allowed disabled:border-base-200 disabled:bg-background-soft-50 disabled:text-input-disabled-text disabled:placeholder:text-input-disabled-text aria-invalid:border-input-error-focus-border aria-invalid:ring-input-error-focus-border/20',
  {
    variants: {
      state: {
        default: 'border-base-200 focus:border-input-primary-focus-border focus:ring-input-primary-focus-border/20',
        error: 'border-input-error-focus-border focus:ring-input-error-focus-border/20',
        success: 'border-input-success-focus-border focus:ring-input-success-focus-border/20',
      },
    },
    defaultVariants: { state: 'default' },
  },
)

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & VariantProps<typeof textareaVariants>

export function Textarea({ className, state, rows = 4, ...props }: TextareaProps) {
  return <textarea rows={rows} className={cn(textareaVariants({ state }), className)} {...props} />
}