import test from 'node:test'
import assert from 'node:assert/strict'
import { LaunchIdentity, LaunchView } from '../src/features/tasks/launch-draft.ts'
const request = { requestId: 'original', mode: 'new', prompt: ' Full prompt\n', reuseSessionId: null, assignment: { workspaceId: 'w', workerId: 'worker', agentKey: 'test', modelId: 'test' } }
const memory = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } }
test('lost response reload recovers full frozen identity; unknown cannot be replaced', () => {
  const storage = memory(), first = new LaunchIdentity(storage, 'connection/team/project/task', 'prefill')
  first.freeze(request)
  const reload = new LaunchIdentity(storage, 'connection/team/project/task', 'changed prefill')
  assert.deepEqual(reload.value.request, request)
  assert.equal(reload.value.status, 'unknown')
  assert.throws(() => reload.reconfirm(), /未知/)
  assert.deepEqual(reload.freeze(reload.value.request), request)
  assert.equal(new LaunchIdentity(storage, 'other/team/project/task', 'new').value.request, null)
})
test('409 retains identity until explicit reconfirmation then freezes current assignment', () => {
  const draft = new LaunchIdentity(memory(), 'scope', 'prompt')
  draft.freeze(request); draft.settle('rejected')
  assert.deepEqual(draft.value.request, request)
  draft.reconfirm()
  assert.equal(draft.value.request, null)
  const current = { ...request, requestId: 'new', assignment: { ...request.assignment, workspaceId: 'current' } }
  assert.deepEqual(draft.freeze(current), current)
})
for (const route of ['task-b/runs', 'task-a/details', null]) test(`late response cannot navigate after ${route ?? 'unmount'}`, async () => {
  const view = new LaunchView(); view.update('task-a/runs')
  const visible = view.capture()
  let release; const response = new Promise(resolve => { release = resolve })
  let navigated = false
  const draft = new LaunchIdentity(memory(), 'scope', 'prompt'); draft.freeze(request)
  const continuation = response.then(() => { draft.settle('confirmed'); if (visible()) navigated = true })
  if (route) view.update(route); else view.leave()
  release(); await continuation
  assert.equal(navigated, false)
  assert.equal(draft.value.status, 'confirmed')
})

// Source contracts bind the exercised pure lifecycle to its actual production owner.
test('Run prefill and production lifecycle wiring include guards, immutable snapshot and independent messaging', async () => {
  const { readFile } = await import('node:fs/promises')
  const { taskPrompt } = await import('../src/features/tasks/launch-draft.ts')
  assert.equal(taskPrompt({ title: 'Title', description: 'Description', acceptanceCriteria: 'Acceptance' }), '任务：Title\n\n描述：\nDescription\n\n验收标准：\nAcceptance')
  assert.ok(taskPrompt({ title: 'T', description: 'D', acceptanceCriteria: null }).endsWith('验收标准：\n'))
  const source = await readFile(new URL('../src/features/tasks/runs.tsx', import.meta.url), 'utf8')
  const board = await readFile(new URL('../src/features/tasks/board.tsx', import.meta.url), 'utf8')
  const router = await readFile(new URL('../src/app/router.tsx', import.meta.url), 'utf8')
  assert.ok(source.indexOf('draft.freeze(') < source.indexOf('await api.launch('))
  assert.match(source, /new LaunchIdentity\(window.sessionStorage/)
  assert.match(source, /taskPrompt\(task\)/)
  assert.match(source, /view.current.update/)
  assert.match(source, /useEffect\(\(\) => \(\) => view.current.leave\(\)/)
  assert.match(source, /if \(visible\(\)\) \{ dirtyCallback.current\(false\); select/)
  assert.match(source, /e.status === 400 \|\| e.status === 409/)
  assert.match(source, /useConfirmDialog/)
  assert.match(source, /confirm\([^\n]+draft.reconfirm\(\)/)
  assert.match(source, /draft.value.status === 'unknown' \|\| \(!frozen && prompt !== taskPrompt/)
  assert.match(source, /JSON.stringify\(task.assignee\)/)
  assert.match(source, /JSON.stringify\(run.snapshot\)/)
  assert.match(source, /追加独立消息（不属于本 Run）/)
  assert.match(source, /初始消息以外的追加消息不属于本 Run、不延长生命周期/)
  assert.match(source, /aria-label="会话模式"/)
  assert.match(source, /api\.cancelRun/)
  assert.match(source, /wemux\.cancel:/)
  assert.match(board, /onDirty=\{value => markDirty\('run', value\)/)
  assert.match(board, /useTaskNavigationGuard\(dirty\)/)
  assert.match(router, /enableBeforeUnload:.*dirty.current/)
})

test('persist failure prevents transport; full request is saved before transport and restored after response loss', async () => {
  let sent = false
  const failing = new LaunchIdentity({ getItem: () => null, setItem: () => { throw Error('quota') } }, 'scope', 'p')
  await assert.rejects(async () => { failing.freeze(request); sent = true }, /quota/)
  assert.equal(sent, false)
  const storage = memory(), mounted = new LaunchIdentity(storage, 'scope', 'p')
  const transport = async frozen => {
    assert.deepEqual(new LaunchIdentity(storage, 'scope', 'ignored').value.request, frozen)
    throw Error('response lost')
  }
  await assert.rejects(transport(mounted.freeze(request)), /response lost/)
  assert.deepEqual(new LaunchIdentity(storage, 'scope', 'ignored').value.request, request)
})
