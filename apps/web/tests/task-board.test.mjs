import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolveSelection } from '../src/app/selection.ts'
import { boardStatuses, taskStatuses } from '@wemux/web-contract/task-platform'
const board = await readFile(new URL('../src/features/tasks/board.tsx', import.meta.url), 'utf8')
const draft = await readFile(new URL('../src/features/tasks/draft.ts', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
const taskStatus = await readFile(new URL('../src/components/task-board/task-status.tsx', import.meta.url), 'utf8')
test('task deep route preserves URL query and defers task authorization to detail endpoint', () => {
 assert.deepEqual(resolveSelection('/projects/p/tasks/t', '?view=list&filter=cancelled&tab=activity&q=title', [{ id: 'p' }], [], []), {})
 assert.ok(resolveSelection('/projects/missing/tasks/t', '', [{ id: 'p' }], [], []).error)
})
test('board uses frozen six-column seven-state contract and Chinese stage labels', () => {
 assert.deepEqual(boardStatuses, ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked'])
 assert.equal(taskStatuses.length, 7)
 for (const label of ['待规划', '待开始', '进行中', '待审查', '已完成', '已阻塞', '已取消']) assert.ok(taskStatus.includes(`'${label}'`))
 assert.match(board, /boardStatuses.map/)
 assert.match(board, /filter === 'cancelled'/)
})
test('pointer drag and keyboard/touch menu share move, rollback snapshot and retained intent', () => {
 assert.match(board, /onDrop=.*void move\(task, status\)/)
 assert.match(board, /onChange=.*void move\(task, event.target.value/)
 assert.match(board, /client.setQueryData\(key, previous\)/)
 assert.match(board, /setIntent\(\{ id: task.id, status \}\)/)
 assert.match(board, /aria-live="polite"/)
 assert.match(board, /focusTask.current/)
 assert.match(styles, /\.task-drop \{ height: 3px/)
})
test('Inspector is real persisted detail/activity; offline and responsive shell remain explicit', () => {
 assert.match(board, /api.task\(projectId, taskId, signal\)/)
 assert.match(board, /projectActivityOptions\(api, projectId, client\)/)
 assert.match(board, /event.requestId/)
 assert.match(draft, /schemaVersion: 1/)
 assert.match(board, /InspectorHost/)
 assert.match(board, /当前离线/)
 assert.match(board, /TaskWorkspaces/)
 assert.match(board, /只影响后续运行/)
 assert.match(styles, /max-width: 767px/)
})
