import type { ReactNode } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog'

/** Shared creation surface: fixed header, scrollable body, fixed footer. */
export function CreationDialog({ title, description, onClose, busy = false, children, footer }: { title: string; description: string; onClose: () => void; busy?: boolean; children: ReactNode; footer?: ReactNode }) {
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="creation-dialog flex max-h-[90dvh] flex-col p-0 sm:p-0" onInteractOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (busy) event.preventDefault() }}>
      <DialogHeader className="shrink-0 border-b border-white/10 px-6 pb-4 pt-5"><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
      {footer && <DialogFooter className="shrink-0 border-t border-white/10 bg-card px-6 py-4">{footer}</DialogFooter>}
    </DialogContent>
  </Dialog>
}
