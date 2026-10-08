// Bounded real-HTTP role ordering. No CAS claim, mocks of authorization or Agent activity.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWemuxServer } from '../../server/src/server.ts'
import { seedLocalAccount } from '../../server/src/test/fixtures/administrator.ts'
import { launchAcceptanceBrowser } from './acceptance-runtime.mjs'
const dist = process.env.WEMUX_NEXT_TEST_DIST
assert.ok(dist?.startsWith('/tmp/'))
const root = await mkdtemp(join(tmpdir(), 'wemux-team-role-interleaving-'))
const result = { passed: false, checks: [], viewports: [], failureStep: null }
let app, browser, step = 'setup'
const password = 'synthetic-role-password-123'
function check(value, label) { assert.ok(value); result.checks.push(label) }
try {
  app = createWemuxServer({ databasePath: join(root, 'db.sqlite'), administratorEmails: ['unused-admin@example.test'], capabilitySecret: 'synthetic-ticket02-capability-secret', webNextStaticPath: dist, google: {}, mail: { WEMUX_PUBLIC_URL: 'http://localhost', WEMUX_SMTP_FROM: 'Test <test@example.test>', WEMUX_MAIL_OUTBOX: join(root, 'outbox') } })
  const origin = await app.listen(0, '127.0.0.1')
  browser = await launchAcceptanceBrowser()
  async function api(context, path, body) {
    const me = body === undefined ? null : await context.request.get(`${origin}/api/auth/me`).then(response => response.json())
    const response = await context.request.fetch(`${origin}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(me?.csrfToken ? { 'x-csrf-token': me.csrfToken } : {}) }, ...(body === undefined ? {} : { data: body }) })
    return { status: response.status(), data: response.status() === 204 ? null : await response.json() }
  }
  async function login(page, username) {
    await page.goto(`${origin}/next/teams`)
    await page.getByLabel('邮箱或用户名', { exact: true }).fill(username)
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('heading', { name: '团队与成员', exact: true }).waitFor()
  }
  function roleForm(page, username) { return page.getByRole('button', { name: `更新 ${username} 角色`, exact: true }).locator('xpath=ancestor::form') }
  async function roleWrite(page, username, role) {
    const form = roleForm(page, username)
    await form.locator('select').selectOption(role)
    await form.getByRole('button').click()
  }
  async function holdRole(page, path, work) {
    let release, entered
    const gate = new Promise(resolve => { release = resolve }), arrival = new Promise(resolve => { entered = resolve })
    let first = true
    const pending = []
    const match = url => url.pathname === path
    await page.route(match, route => {
      const wait = route.request().method() === 'PATCH' && first
      if (wait) { first = false; entered() }
      const handler = (wait ? gate : Promise.resolve()).then(() => route.continue())
      pending.push(handler); return handler
    })
    try { await work({ arrival, release }) }
    finally { release(); await Promise.all(pending); await page.unroute(match) }
  }
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    step = `${name}: owned fixture`
    const owner = await seedLocalAccount(app.store, { username: `role-owner-${name}`, email: `owner-${name}@example.test`, password })
    const successor = await seedLocalAccount(app.store, { username: `role-successor-${name}`, email: `successor-${name}@example.test`, password })
    const target = await seedLocalAccount(app.store, { username: `role-target-${name}`, email: `target-${name}@example.test`, password })
    const contexts = await Promise.all([1, 2, 3, 4].map(() => browser.newContext({ viewport })))
    const [contextA, contextB, contextC, targetContext] = contexts
    const [a, b, c] = await Promise.all(contexts.slice(0, 3).map(context => context.newPage()))
    for (const page of [a, b, c]) { page.setDefaultTimeout(12000); page.on('dialog', dialog => dialog.accept()) }
    await login(a, owner.username); await login(b, owner.username); await login(c, successor.username)
    const meA = (await api(contextA, '/auth/me')).data, meB = (await api(contextB, '/auth/me')).data, meC = (await api(contextC, '/auth/me')).data
    check(meA.user.id === meB.user.id && meA.session.id !== meB.session.id && meC.user.id !== meA.user.id, `${name}: A/B are same owner in distinct sessions; C is distinct successor identity`)
    const create = a.getByRole('button', { name: '创建团队', exact: true }).locator('xpath=ancestor::form')
    await create.locator('[name="name"]').fill(`Role ordering ${name}`); await create.getByRole('button').click()
    await a.getByText('团队已创建，只有你成为所有者。', { exact: true }).waitFor()
    const team = (await api(contextA, '/teams')).data.items.find(value => value.name === `Role ordering ${name}`)
    await api(targetContext, '/auth/login', { login: target.username, password })
    for (const [account, context] of [[successor, contextC], [target, targetContext]]) {
      const invitation = await api(contextA, `/teams/${team.id}/invitations`, { email: account.email })
      check(invitation.status === 201 && (await api(context, `/team-invitations/${invitation.data.token}/accept`, {})).status === 200, `${name}: public invitation creates intended membership`)
    }
    for (const page of [a, b, c]) { await page.reload(); await page.locator('select').first().selectOption(team.id) }
    const members = async () => (await api(contextC, `/teams/${team.id}/members`)).data.items
    const currentRole = async () => (await members()).find(value => value.user.id === target.id).role
    const rolePath = `/api/teams/${team.id}/members/${target.id}`
    step = `${name}: ordered valid writes without optimistic conflict detection`
    // A submits member first, but B's admin reaches and commits at the server first.
    await holdRole(a, rolePath, async ({ arrival, release }) => {
      await roleWrite(a, target.username, 'member'); await arrival
      await roleWrite(b, target.username, 'admin')
      await b.getByText('成员角色已更新。', { exact: true }).waitFor()
      check(await currentRole() === 'admin', `${name}: B commits admin while A request is held`)
      const response = a.waitForResponse(response => new URL(response.url()).pathname === rolePath && response.request().method() === 'PATCH')
      release(); check((await response).status() === 200, `${name}: still-authorized A delayed write accepted`)
      await a.getByText('成员角色已更新。', { exact: true }).waitFor()
      check(await currentRole() === 'member', `${name}: final role is A member by server arrival order, not a CAS conflict`)
    })
    // Refresh B's member view before starting the second ordering, retaining A's form.
    await b.reload(); await b.locator('select').first().selectOption(team.id)
    step = `${name}: stale owner write after transfer to distinct identity`
    await holdRole(a, rolePath, async ({ arrival, release }) => {
      await roleWrite(a, target.username, 'member'); await arrival
      const transfer = b.getByRole('button', { name: `转让所有权给 ${successor.username}`, exact: true }).locator('xpath=ancestor::form')
      await transfer.locator('[name="confirmation"]').fill(team.name); await transfer.getByRole('button').click()
      await transfer.waitFor({ state: 'hidden' })
      check((await members()).find(value => value.user.id === successor.id).role === 'owner', `${name}: B transfers authority to C before A reaches server`)
      await c.reload(); await c.locator('select').first().selectOption(team.id)
      await roleWrite(c, target.username, 'admin')
      await c.getByText('成员角色已更新。', { exact: true }).waitFor()
      check(await currentRole() === 'admin', `${name}: new owner C commits target admin`)
      const denied = []
      const responseListener = response => { if (new URL(response.url()).pathname === rolePath && response.request().method() === 'PATCH') denied.push(response.status()) }
      a.on('response', responseListener)
      try {
        release()
        await a.getByRole('alert').filter({ hasText: '只有 Team owner 可以调整治理角色' }).waitFor()
        check(denied.length > 0 && denied.every(status => status === 403), `${name}: stale A write and CSRF retry denied by current authority`)
        check(await currentRole() === 'admin', `${name}: denial does not overwrite C committed role`)
        // Existing focus-driven reload reconciles opened permissions, no new push/CAS behavior.
        await a.evaluate(() => window.dispatchEvent(new Event('focus')))
        await a.getByRole('button', { name: `更新 ${target.username} 角色`, exact: true }).waitFor({ state: 'hidden' })
        await a.locator('.account-row').filter({ hasText: target.username }).getByText('（管理员）', { exact: false }).waitFor()
        check(await a.getByRole('button', { name: `转让所有权给 ${successor.username}`, exact: true }).count() === 0, `${name}: focused former-owner UI reloads permissions and target role`)
        check((await api(contextA, '/teams')).data.items.find(value => value.id === team.id).role === 'admin', `${name}: public readback confirms former owner now admin`)
      } finally { a.off('response', responseListener) }
    })
    // C remains able to repair/change the role after A's denial, through the actual form.
    const finalWrite = c.waitForResponse(response => new URL(response.url()).pathname === rolePath && response.request().method() === 'PATCH')
    await roleWrite(c, target.username, 'member')
    check((await finalWrite).status() === 200, `${name}: subsequent current-owner write acknowledged`)
    await c.getByText('成员角色已更新。', { exact: true }).waitFor()
    check(await currentRole() === 'member', `${name}: current owner can make subsequent valid UI change`)
    result.viewports.push({ name, passed: true })
    for (const context of contexts) await context.close()
  }
  result.passed = true
} catch { result.failureStep = step; process.exitCode = 1 }
finally {
  await browser?.close(); await app?.close()
  await writeFile(process.env.WEMUX_TICKET02_ROLE_EVIDENCE ?? `${root}-result.json`, JSON.stringify(result, null, 2))
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify(result))
}
