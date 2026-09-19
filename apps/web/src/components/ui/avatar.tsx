import type { ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * Avatar ported from TailGrids (MIT).
 * Structure follows the reference: the root is a bare circular box, the initials
 * live in an absolutely positioned fallback layer that owns the
 * `primary-50 / primary-500` pairing, and the presence dot carries its own ring.
 * Font weight steps with the size while font size is inherited, exactly like the
 * upstream matrix. Presence colours follow the TailGrids legend (busy is amber,
 * offline is red); `away` is our extension and has no upstream counterpart.
 */
const avatarVariants = cva('group/avatar relative flex shrink-0 rounded-full select-none', {
  variants: {
    size: {
      xs: 'size-6 font-medium',
      sm: 'size-8 font-medium',
      md: 'size-10 font-semibold',
      lg: 'size-12 font-semibold',
      xl: 'size-14 font-semibold',
      xxl: 'size-16 font-semibold',
    },
  },
  defaultVariants: { size: 'md' },
})

const fallbackVariants = cva('flex absolute inset-0 items-center justify-center rounded-full bg-primary-50 text-primary-500 uppercase')

const dotVariants = cva('absolute right-0 bottom-0.5 z-10 inline-flex items-center justify-center rounded-full text-white ring-[1.5px] ring-background-50 select-none', {
  variants: {
    size: {
      xs: 'size-1.5',
      sm: 'size-2',
      md: 'size-2.5',
      lg: 'size-3',
      xl: 'size-3.5',
      xxl: 'size-4',
    },
    status: {
      online: 'bg-green-500',
      busy: 'bg-yellow-500',
      offline: 'bg-red-500',
      away: 'bg-base-300',
    },
  },
  defaultVariants: { size: 'md', status: 'online' },
})

function initials(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  const words = trimmed.split(/\s+/)
  const ascii = trimmed.match(/^[A-Za-z]/)
  if (ascii) return words.length > 1 ? words[0][0] + words[1][0] : trimmed.slice(0, 2)
  return trimmed.slice(0, 2)
}

export type AvatarProps = VariantProps<typeof avatarVariants> & {
  src?: string | null
  name: string
  status?: VariantProps<typeof dotVariants>['status']
  className?: string
  fallback?: ReactNode
}

export function Avatar({ src, name, size = 'md', status, className, fallback }: AvatarProps) {
  return (
    <span className={cn(avatarVariants({ size }), className)}>
      <span aria-hidden className={cn(fallbackVariants())}>
        {src ? <img src={src} alt={name} className="size-full aspect-square rounded-full object-cover" /> : (fallback ?? initials(name))}
      </span>
      {status && <span aria-hidden className={cn(dotVariants({ size, status }))} />}
      <span className="sr-only">{name}</span>
    </span>
  )
}