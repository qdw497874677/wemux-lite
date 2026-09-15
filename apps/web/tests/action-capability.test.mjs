import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createApi } from '../src/api/client.ts'
import { unavailableCapability } from '@wemux/web-contract/task-platform'

for (const capability of [{ allowed: true, reasonCode: 'allowed', reason: '' }, ...['invalid_metadata', 'active_run', 'runtime_unavailable', 'workspace_not_ready', 'reuse_ineligible', 'assignment_changed', 'invalid_transition', 'not_found'].map(reasonCode => ({ allowed: false, reasonCode, reason: `Authoritative ${reasonCode}` }))]) {
  test(`API to Web preserves capability value and reason: ${capability.reasonCode}`, async () => {
    const original = globalThis.fetch, originalWindow = globalThis.window
    globalThis.window = { location: { origin: 'http://localhost' } }
    const task = { id: 't', capabilities: { launchNew: capability, transitions: { in_review: capability }, reuse: { s: capability } } }
    globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('/sessions/') ? { id: 's', binding: { agent: {} }, sendCapability: capability } : task), { status: 200, headers: { 'Content-Type': 'application/json' } })
    try {
      const api = createApi({ token: 'test', teamId: 'team' })
      assert.deepEqual((await api.task('p', 't')).capabilities, task.capabilities)
      const session = await api.session('s')
      assert.deepEqual(session.sendCapability, capability)
      assert.equal(session.canSend, capability.allowed)
    } finally { globalThis.fetch = original; globalThis.window = originalWindow }
  })
}
test('existing board, Run detail and composer read authoritative reasons and deny absent DTOs', async () => {
  const source = async path => readFile(new URL(path, import.meta.url), 'utf8')
  assert.equal(unavailableCapability.allowed, false)
  const board = await source('../src/features/tasks/board.tsx')
  assert.match(board, /task.capabilities\?\.transitions\[status\] \?\? unavailableCapability/)
  assert.match(board, /setError\(capability.reason\)/)
  const runs = await source('../src/features/tasks/runs.tsx')
  assert.match(runs, /task.capabilities\?\.reuse\[reuseSessionId\]/)
  assert.match(runs, /launchCapability.reason/)
  assert.match(runs, /!launchCapability.allowed/)
  const composer = await source('../src/features/sessions/conversation.tsx')
  assert.match(composer, /session.sendCapability\?\.allowed === true/)
  assert.match(composer, /session.sendCapability.reason/)
})
