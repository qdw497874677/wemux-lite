import type { ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl text-sm font-medium transition-all duration-[var(--duration-normal)] ease-[var(--ease-out-expo)] active:scale-[.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        default: 'bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 text-white shadow-lg hover:shadow-xl hover:brightness-110',
        secondary: 'bg-secondary/80 text-secondary-foreground shadow-sm hover:bg-secondary hover:shadow-md backdrop-blur-sm',
        outline: 'border border-white/10 bg-white/5 shadow-sm hover:bg-white/10 hover:border-white/20 backdrop-blur-sm',
        ghost: 'hover:bg-white/10 hover:shadow-sm',
        destructive: 'bg-destructive text-destructive-foreground shadow-md hover:bg-destructive/90 hover:shadow-lg',
      },
      size: {
        default: 'h-10 px-5 py-2.5',
        sm: 'h-9 rounded-xl px-4 text-xs',
        lg: 'h-12 rounded-3xl px-7 text-base',
        icon: 'size-10 rounded-2xl',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
