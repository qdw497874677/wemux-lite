import type { ComponentProps } from 'react'
import { LoaderCircle } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

export function Loader({ className, ...props }: ComponentProps<typeof LoaderCircle>) {
  return <LoaderCircle aria-hidden className={cn('size-4 animate-spin text-primary', className)} {...props} />
}
