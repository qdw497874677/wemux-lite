import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { adminRouteFixture } from '../../server/src/test/fixtures/admin-route-fixture.ts'
import { launchAcceptanceBrowser } from './acceptance-runtime.mjs'

const root = await mkdtemp(join(tmpdir(), 'wemux-admin-browser-evidence-'))
const result = { passed: false, checks: [] as string[], failureStep: null as string | null, cleanupFailures: [] as string[] }
let browser: any, fixture: Awaited<ReturnType<typeof adminRouteFixture>> | undefined, step = 'setup'
const check = (value: unknown, label: string) => { assert.ok(value, label); result.checks.push(label) }
try {
  assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'), 'Private UI build required')
  fixture = await adminRouteFixture(resolve(process.env.WEMUX_NEXT_TEST_DIST!))
  const f = fixture
  browser = await launchAcceptanceBrowser()
  for (const [viewport, size] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
    const ownerContext = await browser.newContext({ viewport: size }), memberContext = await browser.newContext({ viewport: size }), adminContext = await browser.newContext({ viewport: size })
    const owner = await ownerContext.newPage(), member = await memberContext.newPage(), admin = await adminContext.newPage()
    for (const page of [owner, member, admin]) { page.setDefaultTimeout(10000); page.on('dialog', (dialog: any) => dialog.accept()) }
    const login = async (page: any, kind: keyof typeof f.accounts, path: string) => {
      await page.goto(`${f.origin}${path}`)
      await page.getByLabel('邮箱或用户名', { exact: true }).fill(f.accounts[kind].email)
      await page.getByLabel('密码', { exact: true }).fill(f.accounts[kind].password)
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await page.getByRole('button', { name: '登录', exact: true }).waitFor({ state: 'hidden' })
    }
    const browserCall = (page: any, path: string, method = 'GET', body?: unknown) => page.evaluate(async ({ path, method, body }: { path: string; method: string; body?: unknown }) => {
      const account = method === 'GET' ? null : await (await fetch('/api/auth/me')).json()
      const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(account?.csrfToken ? { 'x-csrf-token': account.csrfToken } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: response.status, data: response.status === 204 ? null : await response.json() }
    }, { path, method, body })
    const project = (await f.request('/projects', { body: { name: `Browser policy ${viewport}`, teamId: 'default-team' } })).data
    await f.request(`/projects/${project.id}/grants`, { body: { userId: f.accounts.member.id, role: 'manager' } })
    await f.request(`/projects/${project.id}/grants`, { body: { userId: f.accounts.admin.id, role: 'viewer' } })
    const path = `/next/projects/${project.id}`
    step = `${viewport}: non-admin manager sees scoped Project but cannot use instance admin endpoints`
    await login(member, 'member', path)
    await member.getByRole('heading', { name: project.name, exact: true }).waitFor()
    await member.getByRole('button', { name: '项目设置', exact: true }).click()
    await member.getByText('项目改名和删除需要实例管理员身份以及当前项目所有者或管理者权限。', { exact: true }).waitFor()
    assert.equal(await member.getByRole('button', { name: '保存项目名称', exact: true }).count(), 0)
    const baseline = await f.snapshot()
    for (const target of ['/commands', '/commands/policy-command', '/commands/unknown', '/cluster/tailnet']) {
      const denied = await browserCall(member, target)
      check(denied.status === 403 && Object.keys(denied.data).join() === 'error', `${viewport}: browser non-admin denied ${target} without data`)
    }
    for (const target of [`/projects/${project.id}`, '/projects/unknown', `/sessions/${f.sessionId}`, '/sessions/unknown']) for (const method of ['PATCH', 'DELETE']) {
      const denied = await browserCall(member, target, method, method === 'PATCH' ? (target.startsWith('/projects') ? { name: 'forbidden' } : { title: 'forbidden' }) : undefined)
      assert.equal(denied.status, 403)
    }
    assert.deepEqual(await f.snapshot(), baseline)
    check(true, `${viewport}: non-admin manager Cookie cannot mutate Project/Session or audit/commands`)
    check(await f.tailnetCalls() === 0, `${viewport}: denied diagnostics never executed owned tailnet command`)

    step = `${viewport}: admin viewer resource intersection and revoked grant`
    await login(admin, 'admin', path)
    await admin.getByRole('heading', { name: project.name, exact: true }).waitFor()
    await admin.getByRole('button', { name: '项目设置', exact: true }).click()
    await admin.getByText('项目改名和删除需要实例管理员身份以及当前项目所有者或管理者权限。', { exact: true }).waitFor()
    assert.equal((await browserCall(admin, `/projects/${project.id}`, 'PATCH', { name: 'viewer cannot rename' })).status, 404)
    assert.equal((await browserCall(admin, `/projects/${project.id}`, 'DELETE')).status, 404)
    await f.request(`/projects/${project.id}/grants`, { body: { userId: f.accounts.admin.id, role: 'manager' } })
    await admin.evaluate(() => window.dispatchEvent(new Event('focus')))
    await admin.getByRole('button', { name: '项目设置', exact: true }).click()
    const save = admin.getByRole('button', { name: '保存项目名称', exact: true })
    await save.waitFor()
    const form = save.locator('xpath=ancestor::form')
    await form.locator('[name=name]').fill(`Scoped admin renamed ${viewport}`)
    await save.click()
    await admin.getByRole('heading', { name: `Scoped admin renamed ${viewport}`, exact: true }).waitFor()
    check((await f.request(`/projects/${project.id}`)).data.name === `Scoped admin renamed ${viewport}`, `${viewport}: actual admin with Project manager Grant renames through Next`)
    await f.request(`/projects/${project.id}/grants/${f.accounts.admin.id}`, { method: 'DELETE' })
    const revokedSnapshot = await f.snapshot()
    assert.equal((await browserCall(admin, `/projects/${project.id}`, 'PATCH', { name: 'revoked' })).status, 404)
    assert.equal((await browserCall(admin, `/projects/${project.id}`, 'DELETE')).status, 404)
    assert.deepEqual(await f.snapshot(), revokedSnapshot)
    await admin.evaluate(() => window.dispatchEvent(new Event('focus')))
    await admin.getByText('项目不存在或当前账号无权访问', { exact: true }).waitFor()
    check(await admin.getByRole('heading', { name: `Scoped admin renamed ${viewport}`, exact: true }).count() === 0, `${viewport}: revoked admin Grant blocks write and clears protected heading`)

    step = `${viewport}: legitimate owner deletes eligible empty Project through Next`
    await login(owner, 'owner', path)
    await owner.getByRole('heading', { name: `Scoped admin renamed ${viewport}`, exact: true }).waitFor()
    await owner.getByRole('button', { name: '项目设置', exact: true }).click()
    await owner.getByRole('button', { name: '删除项目', exact: true }).click()
    await owner.getByRole('heading', { name: '项目', exact: true }).waitFor()
    assert.equal((await f.request(`/projects/${project.id}`)).status, 404)
    check(true, `${viewport}: actual admin owner safely deletes eligible empty Project via confirmation`)
    // Session controls are not a Next page yet. This checks actual browser Cookie/CSRF HTTP policy,
    // and does not pretend an unimplemented Session-management UI was clicked.
    assert.equal((await browserCall(owner, `/sessions/${f.sessionId}`, 'PATCH', { title: `Owner browser rename ${viewport}` })).status, 200)
    check(true, `${viewport}: admin owner browser Cookie/CSRF retains authorized Session rename`)
    assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true)
    await owner.screenshot({ path: join(root, `${viewport}-owner.png`), fullPage: true })
    await member.screenshot({ path: join(root, `${viewport}-member-policy.png`), fullPage: true })
    await ownerContext.close(); await memberContext.close(); await adminContext.close()
  }
  result.passed = true
} catch { result.failureStep = step }
finally {
  try { await browser?.close() } catch { result.cleanupFailures.push('browser'); result.passed = false }
  try { await fixture?.close() } catch { result.cleanupFailures.push('fixture'); result.passed = false }
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ ...result, evidence: root })); process.exitCode = result.passed ? 0 : 1
