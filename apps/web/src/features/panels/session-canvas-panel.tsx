import { Workflow } from 'lucide-react'

import { Button } from '../../components/ui/button.tsx'
import type { SessionDTO } from '../../api/dto.ts'

export function SessionCanvasPanel({ session, onOpenCanvas }: { session: SessionDTO; onOpenCanvas: () => void }) {
  return <div className="grid h-full place-content-center p-6 text-center"><div className="mx-auto grid size-12 place-items-center rounded-[var(--control-radius)] border border-contrast-border bg-accent text-primary"><Workflow className="size-6" /></div><h3 className="mt-4 text-sm font-semibold">协作画布</h3><p className="mt-2 max-w-64 text-xs leading-5 text-muted-foreground">在项目画布中查看会话关系，并将“{session.title}”展开为可交互节点。独立画布页保持不变。</p><Button className="mt-4" variant="outline" onClick={onOpenCanvas}>在画布中打开</Button></div>
}
