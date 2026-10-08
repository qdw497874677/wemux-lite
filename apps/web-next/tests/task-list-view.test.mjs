import test from 'node:test'
import assert from 'node:assert/strict'
import { taskListView } from '../src/lib/task-list-view.ts'
const tasks = Object.freeze([
  { id: 'd', title: 'Same', status: 'backlog', priority: 'none', updatedAt: '2026-01-02' },
  { id: 'c', title: 'Same', status: 'backlog', priority: 'high', updatedAt: '2026-01-03' },
  { id: 'b', title: 'Beta FIX', status: 'todo', priority: 'high', updatedAt: '2026-01-03' },
  { id: 'a', title: 'Alpha fix', status: 'backlog', priority: 'low', updatedAt: '2026-01-01' },
])
const ids = (query = '', status = '', sort = 'updated') => taskListView(tasks, query, status, sort).map(task => task.id)
test('title substring search is case-insensitive and intersects exact status; clear restores all rows', () => {
  assert.deepEqual(ids('fIx'), ['b', 'a'])
  assert.deepEqual(ids('fix', 'todo'), ['b'])
  assert.deepEqual(ids('Same', 'todo'), [])
  assert.deepEqual(ids('', 'backlog'), ['c', 'd', 'a'])
  assert.deepEqual(ids(''), ['b', 'c', 'd', 'a'])
  assert.deepEqual(ids('missing'), [])
})
test('existing three sort contracts use ascending IDs for ties and do not mutate input', () => {
  assert.deepEqual(ids('', '', 'updated'), ['b', 'c', 'd', 'a'])
  assert.deepEqual(ids('', '', 'title'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(ids('', '', 'priority'), ['b', 'c', 'a', 'd'])
  assert.deepEqual(tasks.map(task => task.id), ['d', 'c', 'b', 'a'])
})
