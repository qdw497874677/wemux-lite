import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { TaskDraft } from '../src/features/tasks/draft.ts'
const task = { title: 'Title', description: 'Original', acceptanceCriteria: null, priority: 'none', metadataJson: { schemaVersion: 1, values: {} }, version: 1 }
test('delayed PATCH acknowledges snapshot, not subsequent input', async () => {
  const draft = new TaskDraft(task)
  draft.edit('description', 'A')
  const { snapshot, patch } = draft.submission()
  let release
  const response = new Promise(resolve => { release = resolve })
  const save = response.then(saved => draft.saved(snapshot, patch, saved))
  draft.edit('description', 'B')
  release({ ...task, description: 'A' })
  await save
  assert.equal(draft.values.description, 'B')
  assert.equal(draft.dirty, true)
  assert.deepEqual(draft.submission().patch, { description: 'B' })
})
for (const initiallyDirty of [false, true]) {
  for (const [field, value] of Object.entries({ title: 'New title', description: 'New description', acceptanceCriteria: 'New criteria', priority: 'high', metadataJson: '{"schemaVersion":1,"values":{"note":"new"}}' })) {
    test(`delayed reload preserves ${field} and baseline after input (initially dirty: ${initiallyDirty})`, async () => {
      const draft = new TaskDraft(task)
      if (initiallyDirty) draft.edit('description', 'Confirmed discard')
      // Capture after the initial dirty confirmation, immediately before GET.
      const revision = draft.revision
      let release
      const response = new Promise(resolve => { release = resolve })
      const reload = response.then(latest => draft.reload(latest, revision))
      draft.edit(field, value)
      const values = { ...draft.values }, patch = draft.submission().patch
      release({ ...task, title: 'Server title', description: 'Server description' })
      await reload
      assert.deepEqual(draft.values, values)
      assert.equal(draft.dirty, true)
      assert.deepEqual(draft.submission().patch, patch)
    })
  }
}
test('reload rejects an edit then revert even when values match the request snapshot', () => {
  const draft = new TaskDraft(task), revision = draft.revision
  draft.edit('description', 'Temporary')
  draft.edit('description', task.description)
  assert.equal(draft.reload({ ...task, description: 'Remote' }, revision), false)
  assert.equal(draft.values.description, task.description)
  assert.equal(draft.dirty, false)
})
test('reload with no intervening edit applies and clears dirty; retry after skipped reload succeeds', () => {
  const draft = new TaskDraft(task), revision = draft.revision
  draft.edit('description', 'New draft')
  assert.equal(draft.reload(task, revision), false)
  assert.equal(draft.reload({ ...task, description: 'Latest' }, draft.revision), true)
  assert.equal(draft.values.description, 'Latest')
  assert.equal(draft.dirty, false)
  assert.equal(draft.remoteChanged, false)
})
test('polling synchronizes clean fields without a CAS increment and retains dirty fields with warning', () => {
  const draft = new TaskDraft(task)
  draft.receive({ ...task, title: 'Remote title' })
  assert.equal(draft.values.title, 'Remote title')
  assert.equal(draft.dirty, false)
  draft.edit('description', 'Local draft')
  const remote = { ...task, title: 'Second title', description: 'Remote draft' }
  draft.receive(remote)
  assert.equal(draft.values.title, 'Second title')
  assert.equal(draft.values.description, 'Local draft')
  assert.equal(draft.remoteChanged, true)
  assert.deepEqual(draft.submission().patch, { description: 'Local draft' })
  draft.reload(remote, draft.revision)
  assert.equal(draft.values.description, 'Remote draft')
  assert.equal(draft.dirty, false)
  assert.equal(draft.remoteChanged, false)
})
test('reverting input is clean and content-identical status refresh does not warn', () => {
  const draft = new TaskDraft(task)
  draft.edit('title', 'Draft')
  draft.receive({ ...task, version: 2 })
  assert.equal(draft.remoteChanged, false)
  draft.edit('title', task.title)
  assert.equal(draft.dirty, false)
})
test('Task Inspector uses one router/history blocker and retains beforeunload', async () => {
  const router = await readFile(new URL('../src/app/router.tsx', import.meta.url), 'utf8')
  const board = await readFile(new URL('../src/features/tasks/board.tsx', import.meta.url), 'utf8')
  assert.match(router, /useBlocker\(/)
  assert.match(router, /current.pathname === next.pathname/)
  assert.match(router, /useConfirmDialog/)
  assert.match(router, /enableBeforeUnload/)
  assert.match(board, /useTaskNavigationGuard\(dirty\)/)
  assert.doesNotMatch(board, /dirty.current = false; (go|refresh)/)
  assert.match(board, /draft.reload\(latest, revision\)/)
  assert.match(board, /onReload=\{\(\) => api.task\(projectId, taskId\)\}/)
})
