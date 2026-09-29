import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const page = await readFile(new URL('../src/components/component-library.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const router = await readFile(new URL('../src/app/host-paths.ts', import.meta.url), 'utf8')

test('component library has a routed production entry', () => {
  assert.match(router, /'\/components'/)
  assert.match(app, /location\.pathname === '\/components'/)
  assert.match(app, /publicComponents/)
  assert.match(app, /path: '\/components'/)
})

test('component library imports real production primitives and task components', () => {
  for (const component of ['Button', 'Badge', 'Input', 'Textarea', 'Select', 'Tabs', 'Dialog', 'DropdownMenu', 'Toast', 'Tooltip', 'TaskCard', 'TaskColumn', 'TaskStatusBadge']) {
    assert.match(page, new RegExp(`\\b${component}\\b`))
  }
  assert.doesNotMatch(page, /function (Button|Badge|Input|TaskCard)\b/)
  assert.match(page, /生产组件的单一视觉索引/)
})
