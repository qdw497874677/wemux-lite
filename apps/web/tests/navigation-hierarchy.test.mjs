import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appSource = (await Promise.all(['App.tsx', 'features/sessions/navigation.tsx'].map(path => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')))).join('\n')
const createDialogSource = await readFile(new URL('../src/components/create-dialog.tsx', import.meta.url), 'utf8')

test('project sidebar separates navigation from contextual sessions and omits worker metadata', () => {
  assert.match(appSource, /aria-label="切换项目"/)
  assert.match(appSource, /aria-label="项目页面"/)
  assert.match(appSource, /aria-label="最近会话"/)
  assert.match(appSource, /formatRelativeTime\(session\.updatedAt\)/)
  assert.doesNotMatch(appSource, />执行节点</)
  assert.doesNotMatch(appSource, /项目 → Workspace → Worker → Session/)
})

test('CreateDialog no longer owns session creation; QuickConversation is the only session entry', () => {
  assert.doesNotMatch(createDialogSource, /kind === 'session'|case 'session'|createSession/)
  assert.match(appSource, /if \(kind === 'session'\)/)
  assert.match(appSource, /setQuickSetup\(true\)/)
})

test('Inspector viewport styles reset margins and use the approved full-screen breakpoint', async () => {
 const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
 assert.match(css, /\.inspector-sheet \{ margin: 0 !important/)
 assert.match(css, /@media \(max-width: 1023px\) \{ \.inspector-sheet \{ inset: 0 !important; width: 100vw !important; height: 100dvh !important/)
})
