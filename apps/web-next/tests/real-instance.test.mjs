import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Supplemental source guard; real-instance.mjs remains the real browser gate.
test('real-instance acceptance is new-only and retains desktop/mobile identity and project checks', async () => {
  const source = await readFile(new URL('./real-instance.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /legacy-projects|legacySameCookie|shared legacy-entry|\$\{base\}\/projects/)
  assert.match(source, /for \(const mobile of \[false, true\]\)/)
  for (const behavior of ['projectsResponse', 'project.name', 'page.reload()', 'page.goBack()', '退出登录', 'diagnostics.filter(entry => !entry.expected)']) {
    assert.ok(source.includes(behavior), `retains ${behavior}`)
  }
})
