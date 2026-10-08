// Synthetic private lifecycle, audit, credential and invitation acceptance. No agents/provider calls.
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWemuxServer } from '../../server/src/server.ts'
import { seedLocalAccount } from '../../server/src/test/fixtures/administrator.ts'
import { browserConfiguration } from './acceptance-runtime.mjs'
const dist = process.env.WEMUX_NEXT_TEST_DIST
assert.ok(dist?.startsWith('/tmp/'))
const root = await mkdtemp(join(tmpdir(), 'wemux-next-account-management-'))
const result = { passed: false, checks: [], failureStep: null }
let browser, app, step = 'setup'
const check = (condition, label) => { assert.ok(condition); result.checks.push(label) }
const password = 'synthetic-lifecycle-password-123'
try {
  app = createWemuxServer({ databasePath: join(root, 'db.sqlite'), administratorEmails: ['admin@example.test'], capabilitySecret: 'synthetic-ticket02-capability-secret', webNextStaticPath: dist, google: {}, mail: { WEMUX_PUBLIC_URL: 'http://wemux-http.test', WEMUX_SMTP_FROM: 'Test <test@example.test>', WEMUX_MAIL_OUTBOX: join(root, 'outbox') } })
  const admin = await seedLocalAccount(app.store, { username: 'synthetic-admin', email: 'admin@example.test', password })
  const local = new URL(await app.listen(0, '127.0.0.1'))
  // Browser-only hostname mapping makes a genuinely non-trustworthy HTTP origin while
  // the server and all network sockets remain loopback-bound. No DNS/network widening.
  const origin = `http://wemux-http.test:${local.port}`
  const config = browserConfiguration(), { chromium } = await import(config.module)
  browser = await chromium.launch({ executablePath: config.executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server', '--host-resolver-rules=MAP wemux-http.test 127.0.0.1'] })
  async function api(page, path, body, method) {
    return page.evaluate(async ({ path, body, method }) => {
      const me = body !== undefined || method === 'DELETE' ? await fetch('/api/auth/me').then(r => r.json()) : null
      const response = await fetch(`/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'content-type': 'application/json', ...(me?.csrfToken ? { 'x-csrf-token': me.csrfToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      return { status: response.status, data: response.status === 204 ? null : await response.json() }
    }, { path, body, method })
  }
  async function login(page, username) {
    step = 'login form'
    await page.goto(`${origin}/next/settings`)
    await page.getByLabel('邮箱或用户名', { exact: true }).fill(username)
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    step = 'login complete'
    await page.getByRole('heading', { name: '账号设置', exact: true }).waitFor()
  }
  async function submit(page, label, values = {}) {
    step = `submit ${label}`
    const button = page.locator('form').getByRole('button', { name: label, exact: true }), form = button.locator('xpath=ancestor::form')
    for (const [name, value] of Object.entries(values)) await form.locator(`[name="${name}"]`).fill(value)
    await button.click()
  }
  const rowFor = (page, username) => page.locator('.account-section').filter({ has: page.getByRole('heading', { name: '实例账号管理', exact: true }) }).locator('.account-row').filter({ hasText: username })
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, acceptDownloads: true }), userContext = await browser.newContext({ viewport })
    const page = await context.newPage(), userPage = await userContext.newPage()
    page.setDefaultTimeout(12000); userPage.setDefaultTimeout(12000)
    let accept = true, confirmations = 0
    page.on('dialog', async dialog => { confirmations++; if (accept) await dialog.accept(); else await dialog.dismiss() })
    userPage.on('dialog', async dialog => { confirmations++; if (accept) await dialog.accept(); else await dialog.dismiss() })
    const self = await seedLocalAccount(app.store, { username: `self-${name}`, email: `self-${name}@example.test`, password })
    const target = await seedLocalAccount(app.store, { username: `managed-${name}`, email: `managed-${name}@example.test`, password })
    step = `${name}: login and last administrator safeguards`
    await login(page, admin.username)
    await page.getByText('账号状态：正常', { exact: true }).waitFor()
    check(await page.getByRole('button', { name: '确认注销账号', exact: true }).isDisabled(), `${name}: default-team administrator deletion blocked in UI`)
    const lastAdmin = await api(page, '/auth/account/lifecycle', { action: 'confirm-deletion', confirmation: '删除我的账号' })
    check(lastAdmin.status === 409 && lastAdmin.data.error.code === 'last_instance_administrator', `${name}: last administrator API safeguard`)
    await rowFor(page, admin.username).getByRole('button', { name: '停用', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '不能停用当前管理员' }).waitFor()
    check((await api(page, '/auth/me')).status === 200, `${name}: last-admin deletion and self-disable blocked`)
    step = `${name}: destructive self deletion confirmation`
    await login(userPage, self.username)
    accept = false
    await submit(userPage, '确认注销账号', { confirmation: '删除我的账号' })
    check((await api(userPage, '/auth/me')).status === 200, `${name}: dismissal does not delete account`)
    accept = true
    await submit(userPage, '确认注销账号', { confirmation: 'wrong-confirmation' })
    await userPage.getByRole('alert').filter({ hasText: '账号操作参数不合法' }).waitFor()
    check((await api(userPage, '/auth/me')).status === 200, `${name}: wrong deletion text rejected`)
    await submit(userPage, '确认注销账号', { confirmation: '删除我的账号' })
    await userPage.getByRole('heading', { name: '登录控制台', exact: true }).waitFor()
    check((await api(userPage, '/auth/me')).status === 401, `${name}: self deletion clears existing identity`)
    check((await api(userPage, '/auth/login', { login: self.username, password })).status === 401, `${name}: deleted account cannot log in`)
    step = `${name}: admin disable restore request and confirm deletion`
    await login(userPage, target.username)
    await page.reload()
    const row = rowFor(page, target.username)
    await row.getByRole('button', { name: '停用', exact: true }).click()
    await row.getByText('（已停用）', { exact: false }).waitFor()
    check((await api(userPage, '/auth/me')).status === 401, `${name}: disable revokes active login`)
    await userPage.evaluate(() => window.dispatchEvent(new Event('focus')))
    await userPage.getByRole('heading', { name: '登录控制台', exact: true }).waitFor()
    await row.getByRole('button', { name: '恢复', exact: true }).click()
    await row.getByText('（正常）', { exact: false }).waitFor()
    await login(userPage, target.username)
    await row.getByRole('button', { name: '请求删除', exact: true }).click()
    await row.getByText('（待删除）', { exact: false }).waitFor()
    check((await api(userPage, '/auth/me')).status === 401, `${name}: deletion request revokes active login`)
    await row.getByRole('button', { name: '确认删除', exact: true }).click()
    await row.waitFor({ state: 'hidden' })
    const accounts = (await api(page, '/auth/account/users')).data.items
    const deleted = accounts.find(value => value.id === target.id)
    check(deleted.status === 'deleted' && deleted.email === null && !deleted.username.includes(target.username), `${name}: admin deletion anonymizes profile`)
    step = `${name}: ownership blocker`
    const owner = await seedLocalAccount(app.store, { username: `owner-${name}`, email: `owner-${name}@example.test`, password })
    await api(userPage, '/auth/logout', {})
    await login(userPage, owner.username)
    const team = (await api(userPage, '/teams', { name: `Owned team ${name}` })).data
    await userPage.reload()
    await userPage.getByText(`Team ${team.id}`, { exact: true }).waitFor()
    check(await userPage.getByRole('button', { name: '确认注销账号', exact: true }).isDisabled(), `${name}: owner deletion blocked visibly`)
    check((await api(userPage, '/auth/account/lifecycle', { action: 'confirm-deletion', confirmation: '删除我的账号' })).status === 409, `${name}: owner deletion also blocked by API`)
    await page.reload()
    await rowFor(page, owner.username).getByRole('button', { name: '请求删除', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '所有权' }).waitFor()
    check((await api(userPage, '/auth/me')).status === 200, `${name}: administrator cannot bypass ownership blocker`)
    step = `${name}: credential scopes and insecure clipboard`
    const secrets = []
    for (const scope of ['read', 'write', 'execute', 'admin']) {
      const form = page.getByRole('button', { name: '创建访问凭据', exact: true }).locator('xpath=ancestor::form')
      for (const [key, label] of Object.entries({ read: '读取', write: '写入', execute: '执行', admin: '管理' })) await form.getByRole('checkbox', { name: label, exact: true }).setChecked(key === scope)
      await submit(page, '创建访问凭据', { name: `${name}-${scope}`, days: '1' })
      await page.locator('.secret-once code').waitFor()
      const secret = await page.locator('.secret-once code').textContent(); secrets.push(secret)
      const list = (await api(page, '/auth/personal-access-tokens')).data.items
      check(JSON.stringify(list.find(value => value.name === `${name}-${scope}`).scopes) === JSON.stringify([scope]), `${name}: exposed ${scope} choice persisted`)
      check(!JSON.stringify(list).includes(secret) && !JSON.stringify(list).includes('tokenHash'), `${name}: ${scope} list does not redisplay secret`)
      const bearer = async (path, body) => {
        const response = await fetch(`${local.origin}/api${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
        return { status: response.status, data: await response.json() }
      }
      check((await bearer('/projects')).status === 200, `${name}: ${scope} permits authorized read`)
      const write = await bearer('/teams', { name: `PAT ${name} ${scope}` })
      check(write.status === (scope === 'write' || scope === 'admin' ? 201 : 403), `${name}: ${scope} write boundary`)
      // Empty execution input reaches validation only; it cannot create a Session or invoke an Agent.
      const execution = await bearer('/sessions', {})
      check(execution.status === (scope === 'execute' || scope === 'admin' ? 400 : 403), `${name}: ${scope} execute scope boundary without execution`)
      const adminWrite = await bearer('/projects', { teamId: team.id, name: `PAT project ${name} ${scope}`, shareScope: 'owner-only' })
      check(adminWrite.status === (scope === 'admin' ? 201 : 403), `${name}: ${scope} admin boundary`)
      if (scope === 'read') {
        check(await page.evaluate(() => !window.isSecureContext && !navigator.clipboard), `${name}: genuine insecure HTTP context`)
        await page.getByRole('button', { name: '复制凭据', exact: true }).click()
        await page.getByText('已选中文本，请按 Ctrl+C 或长按复制。', { exact: true }).waitFor()
        check(await page.evaluate(() => document.getSelection()?.toString() === document.querySelector('.secret-once code')?.textContent), `${name}: clipboard falls back to selected secret and honest guidance`)
      }
      await page.getByRole('button', { name: '隐藏凭据', exact: true }).click()
      check(await page.locator('.secret-once').count() === 0, `${name}: ${scope} secret hidden explicitly`)
    }
    const memberPat = (await api(userPage, '/auth/personal-access-tokens', { name: 'member-admin-scope', scopes: ['admin'], expiresAt: new Date(Date.now() + 86400000).toISOString() })).data.token
    const unauthorizedAdmin = await fetch(`${local.origin}/api/projects`, { method: 'POST', headers: { authorization: `Bearer ${memberPat}`, 'content-type': 'application/json' }, body: JSON.stringify({ teamId: team.id, name: 'must-not-create', shareScope: 'team' }) })
    check(unauthorizedAdmin.status === 403, `${name}: admin scope does not promote nonadministrator account`)
    const memberAudit = await api(userPage, '/auth/account/audit')
    check(memberAudit.status === 200 && memberAudit.data.items.every(entry => entry.actorId === owner.id || entry.resource.id === owner.id), `${name}: member audit limited to own actions and subject`)
    step = `${name}: audit pagination and sanitized export`
    // Generate actual auditable operations through public HTTP; no synthetic audit row injection.
    for (let index = 0; index < 55; index++) assert.equal((await api(page, '/auth/personal-access-tokens', { name: `audit-${name}-${index}`, scopes: ['read'], expiresAt: new Date(Date.now() + 86400000).toISOString() })).status, 201)
    await page.reload()
    const firstResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/account/audit' && !new URL(response.url()).searchParams.has('cursor'))
    await submit(page, '筛选审计', { action: 'pat.created' })
    const first = await (await firstResponse).json()
    check(first.items.length === 50 && !!first.nextCursor, `${name}: first audit page is bounded`)
    const nextResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/account/audit' && new URL(response.url()).searchParams.has('cursor'))
    await page.getByRole('button', { name: '下一页审计', exact: true }).click()
    const next = await (await nextResponse).json()
    check(next.items.length > 0 && next.items.every(item => !first.items.some(old => old.id === item.id)), `${name}: audit pagination has distinct records`)
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('link', { name: '导出当前筛选审计', exact: true }).click()
    const download = await downloadPromise, text = await readFile(await download.path(), 'utf8'), entries = text.trim().split('\n').map(line => JSON.parse(line))
    check(entries.length >= 59 && entries.every(entry => entry.action === 'pat.created'), `${name}: filtered audit export spans pages`)
    check(!text.includes(password) && secrets.every(secret => !text.includes(secret)) && !/tokenHash|passwordHash|csrfToken|codeVerifier/.test(text), `${name}: exported audit excludes secrets and hashes`)
    await page.getByRole('button', { name: '返回第一页', exact: true }).click()
    await page.getByRole('button', { name: '下一页审计', exact: true }).waitFor()
    check(confirmations >= 9, `${name}: destructive actions required browser confirmation`)
    step = `${name}: invitation resend partial failure`
    await userPage.goto(`${origin}/next/teams`)
    await userPage.locator('select').first().selectOption(team.id)
    await submit(userPage, '发送邀请', { email: `invited-${name}@example.test` })
    await userPage.getByRole('link', { name: '在新版查看邀请', exact: true }).waitFor()
    const oldLink = await userPage.getByRole('link', { name: '在新版查看邀请', exact: true }).getAttribute('href')
    const invitationRow = userPage.locator('.account-row').filter({ hasText: `invited-${name}@example.test` })
    const match = url => url.pathname === `/api/teams/${team.id}/invitations`
    await userPage.route(match, route => route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '合成邀请投递失败，请重试' } }) }) : route.continue())
    await invitationRow.getByRole('button', { name: '重发邀请', exact: true }).click()
    await userPage.getByRole('alert').filter({ hasText: '合成邀请投递失败' }).waitFor()
    step = `${name}: resend revocation and recovery`
    check((await api(userPage, `/teams/${team.id}/invitations`)).data.items.every(invite => invite.status === 'revoked'), `${name}: first resend step really revoked old invitation`)
    check(await userPage.getByRole('link', { name: '在新版查看邀请', exact: true }).count() === 0, `${name}: failed resend clears obsolete invite link`)
    await invitationRow.getByText('已撤销', { exact: false }).waitFor()
    await userPage.unroute(match)
    await invitationRow.getByRole('button', { name: '重发邀请', exact: true }).click()
    await userPage.getByRole('link', { name: '在新版查看邀请', exact: true }).waitFor()
    check(await userPage.getByRole('link', { name: '在新版查看邀请', exact: true }).getAttribute('href') !== oldLink, `${name}: resend recovery issues fresh invitation`)
    check((await api(userPage, `/teams/${team.id}/invitations`)).data.items.some(invite => invite.status === 'pending'), `${name}: recovered invitation pending in real API`)
    await context.close(); await userContext.close()
  }
  result.passed = true
} catch { result.failureStep = step; process.exitCode = 1 }
finally {
  await browser?.close(); await app?.close()
  await writeFile(process.env.WEMUX_TICKET02_MANAGEMENT_EVIDENCE ?? `${root}-result.json`, JSON.stringify(result, null, 2))
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify(result))
}
