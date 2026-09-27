import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

import { Button } from './button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog.tsx'

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
}

interface ConfirmOptions { title: string; description: string; confirmLabel?: string; danger?: boolean }
const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null)

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const resolver = useRef<((confirmed: boolean) => void) | null>(null)
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const settle = useCallback((confirmed: boolean) => {
    resolver.current?.(confirmed)
    resolver.current = null
    setOptions(null)
  }, [])
  const confirm = useCallback((next: ConfirmOptions) => new Promise<boolean>(resolve => {
    resolver.current?.(false)
    resolver.current = resolve
    setOptions(next)
  }), [])
  return <ConfirmContext.Provider value={confirm}>{children}{options && <ConfirmDialog open title={options.title} description={options.description} confirmLabel={options.confirmLabel} danger={options.danger} onOpenChange={open => { if (!open) settle(false) }} onConfirm={() => settle(true)} />}</ConfirmContext.Provider>
}

export function useConfirmDialog() {
  const confirm = useContext(ConfirmContext)
  if (!confirm) throw new Error('useConfirmDialog must be used inside ConfirmDialogProvider')
  return confirm
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = '确认', cancelLabel = '取消', danger = false, onConfirm }: ConfirmDialogProps) {
  const [pending, setPending] = useState(false)
  useEffect(() => { if (!open) setPending(false) }, [open])
  const confirm = async () => {
    setPending(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } finally {
      setPending(false)
    }
  }
  return <Dialog open={open} onOpenChange={value => { if (!pending) onOpenChange(value) }}><DialogContent>
    <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
    <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>{cancelLabel}</Button><Button type="button" variant={danger ? 'destructive' : 'default'} disabled={pending} onClick={() => void confirm()}>{pending ? '处理中…' : confirmLabel}</Button></DialogFooter>
  </DialogContent></Dialog>
}
