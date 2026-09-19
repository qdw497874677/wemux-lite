import type { ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * Button recipe ported from TailGrids (MIT, github.com/TailGrids).
 * Geometry, focus ring and disabled states follow the TailGrids
 * `variant x appearance` matrix; colour comes exclusively from the
 * `--color-button-*` tokens in styles.css, so both themes stay in sync.
 * The variant names keep the Wemux API used across the workbench.
 */
const buttonVariants = cva(
  'ring-focus inline-flex items-center justify-center gap-3 whitespace-nowrap rounded-lg font-medium outline-none transition focus:ring-3 disabled:pointer-events-none [&>svg]:shrink-0 [&>svg]:text-current',
  {
    variants: {
      variant: {
        default: '',
        secondary: '',
        outline: '',
        ghost: '',
        destructive: '',
        success: '',
      },
      appearance: {
        fill: '',
        outline: '',
      },
      // 按钮高度由 padding 驱动（TailGrids 的做法）。图标按钮不能“先上 padding 再清零”：
      // Tailwind 里 `p-0` 与 `px-3.5` 的优先级由生成顺序决定，清零不可靠。
      // 因此图标形态直接走独立的 size 键（`icon*`），class 里根本没有 padding。
      size: {
        // TailGrids drives button height with padding (`py-2.5` plus a per-step
        // horizontal padding) and keeps only the icon steps square. Fixed `h-*`
        // utilities would overrule that padding, which made our outlined buttons
        // two pixels shorter than the reference and left filled ones with 0px
        // vertical padding.
        xs: 'px-3.5 py-2.5 text-xs [&>svg]:size-5',
        sm: 'px-3.5 py-2.5 text-sm [&>svg]:size-5',
        default: 'px-4 py-2.5 [&>svg]:size-6',
        lg: 'px-5 py-2.5 [&>svg]:size-6',
        icon: 'size-11 [&>svg]:size-6',
        'icon-xs': 'size-8 text-xs [&>svg]:size-5',
        'icon-sm': 'size-10 text-sm [&>svg]:size-5',
        'icon-lg': 'size-11 text-lg [&>svg]:size-6',
      },
    },
    compoundVariants: [
      // Disabled surfaces for the filled and outlined matrices.
      // Buttons with explicit disabled tokens must not be dimmed a second time by
      // the global `:disabled` opacity, or the token colours wash out.
      {
        variant: ['default', 'destructive', 'success'],
        appearance: 'fill',
        className: 'disabled:bg-button-disabled-background disabled:text-button-disabled-text disabled:opacity-100',
      },
      {
        variant: ['default', 'destructive', 'success'],
        appearance: 'outline',
        className: 'border disabled:border-button-outline-disabled-border disabled:bg-button-outline-disabled-background disabled:text-button-outline-disabled-text disabled:opacity-100',
      },
      {
        variant: 'default',
        appearance: 'fill',
        className: 'bg-button-primary-background text-button-primary-text hover:bg-button-primary-hover-background focus:ring-button-primary-focus-ring',
      },
      {
        variant: 'default',
        appearance: 'outline',
        className: 'border-button-outline-border bg-button-outline-background text-button-outline-text hover:bg-button-outline-hover-background hover:text-button-outline-hover-text focus:ring-button-outline-focus-ring',
      },
      {
        variant: 'secondary',
        className: 'bg-secondary text-secondary-foreground hover:bg-accent focus:ring-button-outline-focus-ring',
      },
      {
        variant: 'outline',
        className: 'border border-button-outline-border bg-button-outline-background text-button-outline-text hover:bg-button-outline-hover-background hover:text-button-outline-hover-text focus:ring-button-outline-focus-ring disabled:border-button-outline-disabled-border disabled:bg-button-outline-disabled-background disabled:text-button-outline-disabled-text disabled:opacity-100',
      },
      {
        variant: 'ghost',
        className: 'text-button-ghost-text hover:bg-button-ghost-hover-background hover:text-button-ghost-hover-text focus:ring-2 focus:ring-primary-400',
      },
      {
        variant: 'destructive',
        appearance: 'fill',
        className: 'bg-button-error-background text-button-error-text hover:bg-button-error-hover-background focus:ring-button-error-focus-ring',
      },
      {
        variant: 'destructive',
        appearance: 'outline',
        className: 'border-button-error-outline-border bg-button-error-outline-background text-button-error-outline-text hover:bg-button-error-outline-hover-background hover:text-button-error-outline-hover-text focus:ring-button-error-outline-focus-ring',
      },
      {
        variant: 'success',
        appearance: 'fill',
        className: 'bg-button-success-background text-button-success-text hover:bg-button-success-hover-background focus:ring-button-success-focus-ring',
      },
      {
        variant: 'success',
        appearance: 'outline',
        className: 'border-button-success-outline-border bg-button-success-outline-background text-button-success-outline-text hover:bg-button-success-outline-hover-background hover:text-button-success-outline-hover-text focus:ring-button-success-outline-focus-ring',
      },
      // Icon buttons keep TailGrids' square geometry per size step.
      { size: 'xs', className: '[&>svg]:size-5' },
    ],
    defaultVariants: { variant: 'default', appearance: 'fill', size: 'default' },
  },
)

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & {
  /** 图标按钮：忽略 padding，改用 TailGrids 对应尺寸的方形边长（size-8 / size-10 / size-11）。 */
  iconOnly?: boolean
}

const iconSizeBySize: Record<NonNullable<ButtonProps['size']>, 'icon-xs' | 'icon-sm' | 'icon' | 'icon-lg'> = {
  xs: 'icon-xs',
  sm: 'icon-sm',
  default: 'icon',
  lg: 'icon-lg',
  icon: 'icon',
  'icon-xs': 'icon-xs',
  'icon-sm': 'icon-sm',
  'icon-lg': 'icon-lg',
}

export function Button({ className, variant, appearance, size, iconOnly, type = 'button', ...props }: ButtonProps) {
  const resolvedSize = iconOnly ? iconSizeBySize[size ?? 'default'] : size
  return <button type={type} className={cn(buttonVariants({ variant, appearance, size: resolvedSize }), className)} {...props} />
}