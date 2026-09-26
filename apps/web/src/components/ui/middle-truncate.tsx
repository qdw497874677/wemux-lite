/* Derived from pingdotgg/t3code (MIT). */
import { cn } from '../../lib/utils.ts'

export function MiddleTruncate({ text, className }: { text: string; className?: string }) {
  if (!text) return null
  const middle = Math.ceil(text.length / 2)
  return (
    <span className={cn('flex min-w-0', className)} title={text}>
      <span className="truncate">{text.slice(0, middle)}</span>
      <span className="shrink-0">{text.slice(middle)}</span>
    </span>
  )
}
