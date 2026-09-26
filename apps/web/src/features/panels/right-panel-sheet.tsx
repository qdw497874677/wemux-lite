/* Derived from pingdotgg/t3code (MIT). */
import { useEffect, type ReactNode } from 'react'

import { Sheet, SheetContent, SheetTitle } from '../../components/ui/sheet.tsx'
import { registerShortcut } from '../../lib/shortcuts.ts'

export function RightPanelSheet({ children, open, onClose }: { children: ReactNode; open: boolean; onClose: () => void }) {
  useEffect(() => open ? registerShortcut({ combo: 'Escape', scope: 'sheet', description: '关闭面板抽屉', priority: 200, allowInEditable: true, handler: onClose }) : undefined, [onClose, open])
  return <Sheet open={open} onOpenChange={next => { if (!next) onClose() }}>
    <SheetContent side="right" showCloseButton={false} className="right-panel-sheet w-[min(92vw,28rem)] max-w-[28rem] p-0 sm:max-w-[28rem]">
      <SheetTitle className="sr-only">会话面板</SheetTitle>
      {children}
    </SheetContent>
  </Sheet>
}
