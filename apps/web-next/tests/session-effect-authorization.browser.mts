import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sessionEffectFixture, sessionEffects } from '../../server/src/test/fixtures/session-effect-fixture.ts'
import { launchAcceptanceBrowser } from './acceptance-runtime.mjs'

// Private real Server + cookie/CSRF authentication, controlled protocol gateway only.
// This verifies authorization from desktop/mobile browsers, not terminal execution or visual design.
// 文件/终端写入通道当前统一 403 write_channel_closed（先于资源授权，不构成存在性 oracle）；读通道仍按授权分级。
const root = await mkdtemp(join(tmpdir(), 'wemux-session-effect-browser-'))
const result = { passed: false, checks: [] as string[], failureStep: null as string | null, cleanupFailures: [] as string[] }
let fixture: Awaited<ReturnType<typeof sessionEffectFixture>> | undefined, browser: any, step = 'setup'
try {
  assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'), 'Private current-source UI required')
  fixture = await sessionEffectFixture(resolve(process.env.WEMUX_NEXT_TEST_DIST!)); const f = fixture
  browser = await launchAcceptanceBrowser()
  assert.equal((await f.request(`/projects/${f.project.id}/grants`, { body: { userId: f.accounts.admin.id, role: 'manager' } })).status, 201)
  for (const [viewport, size] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
    const pages: Record<string, any> = {}, contexts: any[] = [], errors: string[] = []
    try {
      for (const key of ['owner', 'member', 'admin', 'anonymous'] as const) {
        const context = await browser.newContext({ viewport: size }); contexts.push(context)
        const page = await context.newPage(); pages[key] = page
        page.setDefaultTimeout(10000); page.on('pageerror', () => errors.push('pageerror'))
        step = `${viewport}: ${key} login`
        await page.goto(`${f.origin}/next/projects/${f.project.id}`)
        if (key !== 'anonymous') {
          await page.getByLabel('邮箱或用户名', { exact: true }).fill(f.accounts[key].email)
          await page.getByLabel('密码', { exact: true }).fill(f.accounts[key].password)
          await page.getByRole('button', { name: '登录', exact: true }).click()
          await page.getByRole('heading', { name: f.project.name, exact: true }).waitFor()
        }
      }
      const api = (page: any, path: string, body: unknown, malformed = false) => page.evaluate(async ({ path, body, malformed }: { path: string; body: unknown; malformed: boolean }) => {
        const me = await (await fetch('/api/auth/me')).json()
        const response = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(me.csrfToken ? { 'x-csrf-token': me.csrfToken } : {}) }, body: malformed ? '{' : JSON.stringify(body) })
        return { status: response.status, data: await response.json() }
      }, { path, body, malformed })
      const matrix = [
        { name: 'owner', page: 'owner', scope: 'owner-only', role: 'viewer', statuses: [403, 403, 403, 403, 403] },
        { name: 'contributor', page: 'member', scope: 'project', role: 'contributor', statuses: [403, 403, 403, 403, 403] },
        { name: 'viewer', page: 'member', scope: 'project', role: 'viewer', statuses: [403, 403, 403, 403, 403] },
        { name: 'readable manager', page: 'member', scope: 'project', role: 'manager', statuses: [403, 403, 403, 403, 403] },
        { name: 'unreadable manager', page: 'member', scope: 'owner-only', role: 'manager', statuses: [403, 403, 403, 403, 403] },
        { name: 'ungranted admin', page: 'admin', scope: 'owner-only', role: 'manager', statuses: [403, 403, 403, 403, 403] },
        { name: 'anonymous', page: 'anonymous', scope: 'project', role: 'viewer', statuses: [401, 401, 401, 401, 401] },
      ] as const
      for (const row of matrix) {
        await f.role(row.role); await f.scope(row.scope)
        for (const [index, effect] of sessionEffects.entries()) {
          step = `${viewport}: ${row.name} ${effect.path}`
          const before = f.effects.length, expected = row.statuses[index]
          const response = await api(pages[row.page], `/sessions/${f.sessionId}${effect.path}`, effect.body)
          assert.equal(response.status, expected)
          assert.equal(f.effects.length - before, expected < 300 ? 1 : 0)
          if (expected >= 400) {
            assert.equal((await api(pages[row.page], `/sessions/${f.sessionId}${effect.path}`, null, true)).status, expected)
            assert.equal(f.effects.length, before)
          }
          result.checks.push(`${step}: status ${expected}, ${expected < 300 ? 'one controlled dispatch' : 'zero dispatch including malformed JSON'}`)
        }
      }
      await f.scope('project'); await f.role('viewer')
      for (const operation of ['list', 'read', 'diff']) {
        step = `${viewport}: viewer fs/${operation}`
        const before = f.effects.length
        assert.equal((await api(pages.member, `/sessions/${f.sessionId}/fs/${operation}`, { subpath: 'fixture.txt' })).status, 200)
        assert.equal(f.effects.length, before + 1)
        result.checks.push(`${step}: read remains allowed`)
      }
      step = `${viewport}: viewer terminal stream`
      const streamStatus = await pages.member.evaluate(async (id: string) => {
        const abort = new AbortController()
        try { const response = await fetch(`/api/sessions/${id}/terminal/stream`, { signal: abort.signal }); await response.body?.cancel(); return response.status }
        finally { abort.abort() }
      }, f.sessionId)
      assert.equal(streamStatus, 200); result.checks.push(`${step}: read remains allowed`)
      assert.deepEqual(errors, []); result.checks.push(`${viewport}: no pageerror`)
    } finally { for (const context of contexts) await context.close() }
  }
  result.passed = true
} catch (error) { result.failureStep = step; console.error('DIAG', step, error instanceof Error ? error.message : String(error)) }
finally {
  if (browser) await browser.close().catch(() => { result.cleanupFailures.push('browser') })
  if (fixture) await fixture.close().catch(() => { result.cleanupFailures.push('fixture') })
  if (result.cleanupFailures.length) result.passed = false
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ ...result, evidence: join(root, 'result.json') }))
process.exitCode = result.passed ? 0 : 1
