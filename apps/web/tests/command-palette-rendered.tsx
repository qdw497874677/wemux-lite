import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { CommandPalette } from '../src/features/command-palette/command-palette.tsx'
import { installShortcutListener, registerShortcut } from '../src/lib/shortcuts.ts'
import type { SessionDTO } from '../src/api/dto.ts'

const sessions = [
  { id: 'session-release', projectId: 'project-1', title: '发布检查', updatedAt: '2026-04-02T00:00:00Z', canRead: true, archivedAt: null },
  { id: 'session-login', projectId: 'project-1', title: '登录修复', updatedAt: '2026-04-01T00:00:00Z', canRead: true, archivedAt: null },
] as SessionDTO[]

function Harness() {
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState('尚未执行')
  useEffect(() => installShortcutListener(), [])
  useEffect(() => registerShortcut({ combo: 'Mod+K', scope: 'global', description: '打开命令面板', priority: 400, allowInEditable: true, handler: () => setOpen(value => !value) }), [])
  return <main>
    <p data-testid="result">{result}</p>
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      projectId="project-1"
      sessions={sessions}
      commands={[
        { id: 'first', label: '第一条命令', description: '用于键盘选择', run: () => setResult('command:first') },
        { id: 'second', label: '第二条命令', description: '用于键盘选择', run: () => setResult('command:second') },
      ]}
      onOpenSession={id => setResult(`session:${id}`)}
    />
  </main>
}

createRoot(document.getElementById('root')!).render(<Harness />)
