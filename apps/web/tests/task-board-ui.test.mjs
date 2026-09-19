import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const board = await readFile(new URL('../src/features/tasks/board.tsx', import.meta.url), 'utf8')
const componentDir = new URL('../src/components/task-board/', import.meta.url)
const componentFiles = await readdir(componentDir)
const components = (await Promise.all(componentFiles.map(file => readFile(new URL(file, componentDir), 'utf8')))).join('\n')
const contract = await import('@wemux/web-contract/task-platform')

test('task board preserves the complete Wemux workflow', () => {
  assert.deepEqual(contract.boardStatuses, ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked'])
  assert.equal(contract.taskStatuses.length, 7)
  assert.match(board, /task\.capabilities\?\.transitions/)
  assert.match(board, /api\.patchTask/)
  assert.match(board, /client\.setQueryData\(key, previous\)/)
  assert.match(board, /InspectorHost/)
})

test('task board supports compact board and list presentation', () => {
  assert.match(board, /TaskColumn/)
  assert.match(board, /TaskCard/)
  assert.match(board, /task-board-toolbar/)
  assert.match(board, /view = params\.get\('view'\)/)
  assert.match(board, /onDrop=/)
  assert.match(board, /状态筛选/)
  assert.match(components, /draggable/)
  assert.match(board, /aria-pressed/)
  assert.match(components, /TaskPriorityBadge/)
  assert.match(components, /TaskStatusBadge/)
})
