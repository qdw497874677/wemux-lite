import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')

test('resource and task creation share a guarded, scrollable dialog', () => {
  const dialog = source('../src/components/creation-dialog.tsx')
  assert.match(dialog, /max-h-\[90dvh\]/)
  assert.match(dialog, /overflow-y-auto/)
  assert.match(dialog, /onInteractOutside=.*preventDefault/)
  assert.match(dialog, /!open && !busy/)
  for (const path of ['../src/components/create-dialog.tsx', '../src/features/tasks/board.tsx', '../src/features/tasks/workspaces.tsx']) {
    const form = source(path)
    assert.match(form, /<CreationDialog/)
    assert.match(form, /footer=/)
    assert.match(form, /useConfirmDialog/)
  }
  assert.doesNotMatch(source('../src/components/create-dialog.tsx'), /dirty.current = true/)
  assert.doesNotMatch(source('../src/components/create-dialog.tsx'), /window.confirm/)
  assert.match(source('../src/features/tasks/board.tsx'), /onBusy=\{setCreateBusy\}/)
})
test('unified sidebar replaces conversation focus while retaining return and touch newline', () => {
  const app = source('../src/App.tsx')
  assert.match(app, /<SidebarProvider>/)
  assert.match(app, /<AppSidebar collapsible="icon">/)
  assert.match(app, /<SidebarRail \/>/)
  assert.doesNotMatch(app, /conversation-focus/)
  assert.doesNotMatch(app, /展开导航/)
  assert.doesNotMatch(app, /onFocus=.*setConversationFocus\(false\)/)
  assert.match(app, /projectId && !sessionId/)
  assert.match(source('../src/styles.css'), /--chat-max-width: 45rem/)
  assert.match(source('../src/styles.css'), /max-width: var\(--chat-max-width\)/)
  const composer = source('../src/components/ui/ai-prompt-input.tsx')
  assert.match(composer, /nativeEvent\.isComposing/)
  assert.match(composer, /pointer: fine/)
  assert.match(composer, /event.ctrlKey \|\| event.metaKey/)
})
test('task help explains management versus execution and links to full conversation', () => {
  assert.match(source('../src/features/tasks/board.tsx'), /运行成功不会自动完成任务/)
  const runs = source('../src/features/tasks/runs.tsx')
  assert.match(runs, /打开完整对话/)
  assert.match(runs, /encodeURIComponent\(run.sessionId\)/)
  assert.doesNotMatch(source('../src/features/tasks/workspaces.tsx'), /Ticket05/)
})
