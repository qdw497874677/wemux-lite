import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('Session Surface defines presentation density without creating another runtime or composer', async () => {
  const source = await read('../src/features/sessions/session-surface.tsx')
  assert.match(source, /export type SessionPresentation = 'canvas-summary' \| 'canvas-interactive' \| 'focus' \| 'run'/)
  assert.match(source, /useSession\(api, session\.id, revision\)/)
  assert.match(source, /<Composer/)
  assert.match(source, /<ClusterControls/)
  assert.match(source, /ConversationScrollButton/)
  assert.match(source, /<Conversation/)
  assert.match(source, /presentation === 'canvas-interactive'/)
  assert.doesNotMatch(source, /new WebSocket|EventSource/)
})

test('canvas React Flow adapter renders only the selected interactive Surface and locks dragging', async () => {
  const source = await read('../src/features/session-canvas/adapters/react-flow/react-flow-canvas.tsx')
  const preference = await read('../src/features/session-canvas/session-surface-preference.ts')
  assert.match(source, /interactiveSessionId/)
  assert.match(source, /data\.interactive/)
  assert.match(source, /SessionSurface/)
  assert.match(source, /data\.selected && data\.interactive/)
  assert.match(source, /nodrag nopan nowheel/)
  assert.match(source, /draggable: node\.sessionId !== interactiveSessionId/)
  assert.match(source, /收起为摘要/)
  assert.match(preference, /wemux\.session-surface-preferences\.v1/)
  assert.match(preference, /canvas-summary/)
})

test('canvas and focus navigation encode the active session in URL state', async () => {
  const app = await read('../src/App.tsx')
  const router = await read('../src/app/router.tsx')
  assert.match(app, /canvasSearch\.get\('session'\)/)
  assert.match(app, /view=canvas/)
  assert.match(app, /from=canvas/)
  assert.match(router, /\/projects\/\$projectId\/canvas/)
})
