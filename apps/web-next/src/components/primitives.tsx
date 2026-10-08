// Adapted from Paperclip ui Button, Input and EmptyState (MIT); see source record.
import type { ComponentProps } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../lib/classes.ts'

export function Button({ className, variant = 'default', type = 'button', ...props }: ComponentProps<'button'> & { variant?: 'default' | 'ghost' | 'outline' }) {
  return <button type={type} data-slot="button" className={cn('button', `button-${variant}`, className)} {...props} />
}
export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn('input', className)} {...props} />
}
export function EmptyState({ icon: Icon, title, message, action, onAction }: { icon: LucideIcon; title: string; message: string; action?: string; onAction?: () => void }) {
  return <div className="empty-state"><Icon aria-hidden className="empty-icon" /><h2>{title}</h2><p>{message}</p>{action && onAction && <Button onClick={onAction}>{action}</Button>}</div>
}
