import type { ReactNode } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog'

/** Shared creation surface: bounded scroll, consistent title, guarded dismissal. */
export function CreationDialog({ title, description, onClose, busy = false, children }: { title: string; description: string; onClose: () => void; busy?: boolean; children: ReactNode }) {
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="creation-dialog max-h-[90dvh] overflow-y-auto p-4 sm:p-6" onInteractOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (busy) event.preventDefault() }}>
      <DialogHeader className="pr-8"><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      {children}
    </DialogContent>
  </Dialog>
}
