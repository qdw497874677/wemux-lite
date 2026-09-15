import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appSource = (await Promise.all(['App.tsx', 'features/sessions/navigation.tsx'].map(path => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')))).join('\n')
const createDialogSource = await readFile(new URL('../src/components/create-dialog.tsx', import.meta.url), 'utf8')

test('workbench navigation nests sessions under their workspace and treats workers as execution metadata', () => {
  assert.match(appSource, /项目 → Workspace → Session；Worker 提供执行环境/)
  assert.match(appSource, /item\.workspaceId === workspace\.id/)
  assert.match(appSource, />执行节点</)
  assert.match(appSource, /onCreate\('session', workspace\.id\)/)
  assert.doesNotMatch(appSource, /项目 → Workspace → Worker → Session/)
})

test('creating a session from a workspace branch preselects that workspace and its worker', () => {
  assert.match(createDialogSource, /defaultWorkspaceId = ''/)
  assert.match(createDialogSource, /const defaultWorkspace = workspaces\.find\(item => item\.id === defaultWorkspaceId\)/)
  assert.match(createDialogSource, /useState\(defaultWorkspace\?\.workerId \?\? ''\)/)
  assert.match(createDialogSource, /useState\(defaultWorkspace\?\.id \?\? ''\)/)
})

test('Inspector viewport styles reset margins and use the approved full-screen breakpoint', async () => {
 const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
 assert.match(css, /\.inspector-sheet \{ margin: 0 !important/)
 assert.match(css, /@media \(max-width: 1023px\) \{ \.inspector-sheet \{ inset: 0 !important; width: 100vw !important; height: 100dvh !important/)
})
