// Private, synthetic HTTP/browser acceptance. No real accounts, agents or external providers.
// Run through scripts/test-with-browser.mjs with WEMUX_NEXT_TEST_DIST pointing to a private Vite build.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { createWemuxServer } from '../../server/src/server.ts'
import { launchAcceptanceBrowser } from './acceptance-runtime.mjs'
const dist = process.env.WEMUX_NEXT_TEST_DIST
assert.ok(dist?.startsWith('/tmp/'), 'Use a private /tmp dist')
const root = await mkdtemp(join(tmpdir(), 'wemux-ticket02-browser-'))
const evidence = process.env.WEMUX_TICKET02_EVIDENCE ?? `${root}-result.json`
const result = { passed: false, checks: [], viewports: [], failureStep: null }
let app, browser, step = 'setup'
const check = (value, name) => { assert.ok(value, name); result.checks.push(name) }
try {
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve))
  const origin = `http://127.0.0.1:${port}`, outbox = join(root, 'outbox')
  await mkdir(outbox)
  app = createWemuxServer({ databasePath: join(root, 'server.sqlite'), administratorEmails: ['owner-desktop@example.test', 'owner-mobile@example.test'], capabilitySecret: 'synthetic-ticket02-capability-secret', webNextStaticPath: resolve(dist), mail: { WEMUX_PUBLIC_URL: origin, WEMUX_SMTP_FROM: 'Wemux <test@example.test>', WEMUX_MAIL_OUTBOX: outbox }, google: {} })
  await app.listen(port)
  browser = await launchAcceptanceBrowser()
  const mailLinks = async (email, path) => {
    const names = await readdir(outbox); const messages = []
    for (const name of names) {
      const raw = await readFile(join(outbox, name), 'utf8')
      if (!raw.includes(email)) continue
      const text = Buffer.from(raw.slice(raw.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString()
      const links = [...text.matchAll(/http:\/\/[^\s]+/g)].map(match => new URL(match[0]))
      if (links.some(url => url.pathname === path)) messages.push({ name, links })
    }
    messages.sort((a, b) => a.name.localeCompare(b.name))
    const links = messages.at(-1)?.links
    assert.ok(links)
    const next = links.find(url => url.pathname === path), legacy = links.find(url => url.pathname === path.replace('/next', ''))
    check(!!next && !!legacy && next.search === legacy.search, `dual mail links share challenge: ${path}`)
    return { next: next.href, legacy: legacy.href, token: next.searchParams.get('token') }
  }
  const api = async (context, path, body, method, csrfOverride) => {
    let csrf = csrfOverride
    if (body !== undefined || method === 'DELETE' || method === 'PATCH') {
      if (csrf === undefined) { const me = await context.request.get(`${origin}/api/auth/me`); if (me.ok()) csrf = (await me.json()).csrfToken }
    }
    const response = await context.request.fetch(`${origin}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Origin: origin, ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...(body === undefined ? {} : { data: body }) })
    return { status: response.status(), data: response.status() === 204 ? null : await response.json() }
  }
  const waitText = async (page, text) => { step = `wait: ${text}`; await page.getByText(text, { exact: false }).first().waitFor() }
  const submit = async (page, label, values = {}) => {
    step = `submit: ${label}`
    const button = page.locator('form').getByRole('button', { name: label, exact: true })
    const form = button.locator('xpath=ancestor::form')
    for (const [name, value] of Object.entries(values)) await form.locator(`[name="${name}"]`).fill(value)
    await button.click()
  }
  const layout = async (page, stage) => {
    step = `layout: ${stage}`
    const overflow = await page.evaluate(() => [document.documentElement, ...document.querySelectorAll('#main-content, .account-section, .account-form, .account-row, .secret-once')].filter(element => element.getBoundingClientRect().width > 0 && element.scrollWidth > element.clientWidth + 1).map(element => ({ tag: element.tagName, className: element.className, width: element.clientWidth, scroll: element.scrollWidth })))
    if (overflow.length) result.layoutFailure = { stage, overflow }
    check(overflow.length === 0, `document and content fit: ${stage}`)
  }
  const stableProjectRefresh = async (page, project, viewport) => {
    step = `${viewport}: refresh fixture project list`
    await page.goto(`${origin}/next/projects`)
    await page.locator('#main-content').getByText(project.name, { exact: true }).waitFor()
    step = `${viewport}: refresh fixture focus search`
    const search = page.locator('#project-search')
    await search.fill(project.name)
    await search.focus()
    const input = await search.elementHandle()
    for (const trigger of ['focus', 'poll']) {
      step = `${viewport}: unchanged-authority ${trigger} refresh`
      let release
      const held = new Promise(resolve => { release = resolve })
      const match = url => url.pathname === '/api/projects'
      const handlers = []
      await page.route(match, route => { const done = held.then(() => route.continue()); handlers.push(done); return done })
      try {
        const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/projects', { timeout: 20000 })
        if (trigger === 'focus') await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        await request
        await page.getByText('正在加载获权项目…', { exact: true }).waitFor()
        check(await input.evaluate(element => element.isConnected && document.activeElement === element), `${viewport}: ${trigger} refresh retains focused input DOM while pending`)
        check(await search.inputValue() === project.name, `${viewport}: ${trigger} refresh retains filter while pending`)
        check(await page.locator('#main-content').getByText(project.name, { exact: true }).count() === 0, `${viewport}: ${trigger} refresh clears protected project results immediately`)
        check(await page.getByRole('heading', { name: '还没有可访问的项目', exact: true }).count() === 0, `${viewport}: ${trigger} refresh does not claim empty results while pending`)
        release()
        await page.locator('#main-content').getByText(project.name, { exact: true }).waitFor()
        check(await input.evaluate(element => element.isConnected && document.activeElement === element), `${viewport}: ${trigger} refresh retains focused input DOM after completion`)
        check(await search.inputValue() === project.name, `${viewport}: ${trigger} refresh retains filter after completion`)
      } finally { release(); await Promise.all(handlers); await page.unroute(match) }
    }
    await input.dispose()
  }
  const mailAction = async (page, expected, work) => {
    const endpoints = ['/api/auth/password/reset', '/api/auth/email/verify', '/api/auth/email/change/confirm']
    const calls = []
    const record = request => { if (request.method() === 'POST' && endpoints.includes(new URL(request.url()).pathname)) calls.push(new URL(request.url()).pathname) }
    page.on('request', record)
    try {
      await work()
      await page.waitForTimeout(200)
      check(JSON.stringify(calls) === JSON.stringify([expected]), `mail action calls only ${expected}`)
    } finally { page.off('request', record) }
  }
  const register = async (page, email, name, password) => {
    step = `register ${name}: open`
    await page.goto(`${origin}/next/login`)
    await page.getByRole('button', { name: '注册账号', exact: true }).click()
    step = `register ${name}: submit`
    await submit(page, '发送注册验证邮件', { email, displayName: name, password })
    await waitText(page, '请求已受理')
    step = `register ${name}: mail`
    const original = await mailLinks(email, '/next/auth/verify-email')
    await page.getByRole('button', { name: '重发验证邮件', exact: true }).first().click()
    await submit(page, '重发验证邮件', { email })
    await waitText(page, '请求已受理')
    const links = await mailLinks(email, '/next/auth/verify-email')
    check((await api(page.context(), '/auth/email/verify', { token: original.token })).status === 409, 'resend invalidates earlier verification token')
    await page.goto(links.next)
    check((await api(page.context(), '/auth/me')).status === 401, 'GET verification does not consume token')
    await mailAction(page, '/api/auth/email/verify', async () => { await page.getByRole('button', { name: '确认并激活账号', exact: true }).click(); await page.getByRole('heading', { name: '项目', exact: true }).waitFor() })
    step = `register ${name}: projects`
    await page.getByRole('heading', { name: '项目', exact: true }).waitFor()
    check((await api(page.context(), '/auth/email/verify', { token: links.token })).status === 409, 'verification is one-use across entries')
    return (await api(page.context(), '/auth/me')).data.user
  }
  const login = async (page, email, password, path = '/next/settings') => {
    step = `login: ${path}`
    await page.goto(`${origin}${path}`)
    await page.getByLabel('邮箱或用户名', { exact: true }).fill(email)
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('heading', { name: path === '/next/settings' ? '账号设置' : '接受团队邀请', exact: true }).waitFor()
  }
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport }), inviteeContext = await browser.newContext({ viewport })
    const page = await context.newPage(), invited = await inviteeContext.newPage()
    page.setDefaultTimeout(12000); invited.setDefaultTimeout(12000)
    page.on('dialog', dialog => dialog.accept()); invited.on('dialog', dialog => dialog.accept())
    const pageErrors = []; result.authStatuses = []; page.on('response', response => { const path = new URL(response.url()).pathname; if (['/api/auth/logout-all','/api/auth/me','/api/auth/login'].includes(path)) result.authStatuses.push([path,response.status()]) }); page.on('pageerror', () => pageErrors.push('pageerror')); invited.on('pageerror', () => pageErrors.push('pageerror'))
    const ownerEmail = `owner-${name}@example.test`, memberEmail = `member-${name}@example.test`, changedEmail = `changed-${name}@example.test`
    const password = 'synthetic account password 123', newPassword = 'replacement account password 456'
    step = `${name}: registration`
    const owner = await register(page, ownerEmail, `Owner ${name}`, password)
    if (name === 'desktop') check((await api(context, '/settings/registration-policy', { policy: 'open' }, 'PATCH')).status === 200, 'administrator opens synthetic registration')
    const member = await register(invited, memberEmail, `Member ${name}`, password)
    step = `${name}: security`
    await page.goto(`${origin}/next/settings`)
    await page.reload(); await page.getByRole('heading', { name: '账号设置', exact: true }).waitFor()
    if (name === 'desktop') {
      step = 'desktop: administrator lifecycle UI'
      const row = page.locator('.account-row').filter({ hasText: memberEmail }).last()
      await row.getByRole('button', { name: '停用', exact: true }).click()
      await waitText(page, '账号操作已完成')
      check((await api(inviteeContext, '/auth/me')).status === 401, 'administrator disable revokes existing login')
      await row.getByRole('button', { name: '恢复', exact: true }).click()
      await waitText(page, '账号操作已完成')
      await login(invited, memberEmail, password)
      check((await api(context, '/auth/account/audit?action=account.disabled')).data.items.length > 0, 'lifecycle audit available')
    }
    await waitText(page, '最后一种登录方式，不可移除')
    await layout(page, `${name}: account settings`)
    await waitText(page, 'Google')
    check(await page.getByRole('button', { name: '绑定 Google 登录', exact: true }).isDisabled(), 'unconfigured Google disabled with reason')
    await submit(page, '修改密码', { currentPassword: password, newPassword, confirm: 'incorrect confirmation' })
    await waitText(page, '两次输入的新密码不一致')
    await submit(page, '修改密码', { currentPassword: password, newPassword, confirm: newPassword })
    await waitText(page, '密码已更新')
    await submit(page, '申请更换邮箱', { newEmail: changedEmail, currentPassword: newPassword })
    await waitText(page, '确认邮件已发送')
    const changed = await mailLinks(changedEmail, '/next/auth/confirm-email-change')
    await page.goto(changed.next); await mailAction(page, '/api/auth/email/change/confirm', async () => { await page.getByRole('button', { name: '确认更换邮箱', exact: true }).click(); await waitText(page, '操作已完成') })
    await api(context, '/auth/logout', {})
    await login(page, changedEmail, newPassword)
    await submit(page, '创建访问凭据', { name: `Ticket02 ${name}`, days: '3' }); await waitText(page, '凭据已创建'); await layout(page, `${name}: displayed PAT`)
    await page.getByRole('button', { name: '隐藏凭据', exact: true }).click()
    await submit(page, `轮换 Ticket02 ${name}`, { days: '2' }); await page.getByRole('button', { name: '隐藏凭据', exact: true }).waitFor()
    await page.getByRole('button', { name: '撤销凭据', exact: true }).click(); await page.getByRole('button', { name: '撤销凭据', exact: true }).waitFor({ state: 'hidden' })
    step = `${name}: team create invite accept`
    await page.goto(`${origin}/next/teams`)
    await submit(page, '创建团队', { name: `Team ${name}` }); await waitText(page, '团队已创建')
    await submit(page, '发送邀请', { email: memberEmail }); await waitText(page, '邀请已创建')
    const invitation = await mailLinks(memberEmail, '/next/join')
    const team = (await api(context, '/teams')).data.items.find(value => value.name === `Team ${name}`)
    const projectResponse = await api(context, '/projects', { teamId: team.id, name: `Revoked project ${name}`, shareScope: 'team' })
    check(projectResponse.status === 201, 'create synthetic team-visible project')
    const project = projectResponse.data
    check((await api(inviteeContext, `/teams/${team.id}/members`)).status === 403, 'cross-team member read rejected before acceptance')
    check((await api(context, `/teams/${team.id}/invitations`, { email: 'csrf@example.test' }, 'POST', '')).status === 403, 'missing CSRF rejected')
    check((await api(context, `/team-invitations/${invitation.token}/accept`, {})).status === 403, 'wrong account cannot accept invitation')
    step = `${name}: accept invitation UI`
    await invited.goto(invitation.next); await invited.getByRole('button', { name: '接受邀请', exact: true }).waitFor(); await layout(invited, `${name}: invitation`); await invited.getByRole('button', { name: '接受邀请', exact: true }).click()
    await invited.getByRole('heading', { name: '团队与成员', exact: true }).waitFor()
    step = `${name}: repeated invitation`
    check((await api(inviteeContext, `/team-invitations/${invitation.token}/accept`, {})).status === 409, 'repeat invitation acceptance rejected as consumed')
    check((await api(inviteeContext, `/teams/${team.id}/invitations`, { email: 'forbidden@example.test' })).status === 403, 'ordinary member invitation rejected')
    check((await api(inviteeContext, `/auth/account/users`)).status === 403, 'ordinary account admin listing rejected')
    await page.reload(); await page.locator('select').first().selectOption(team.id)
    await waitText(page, member.username); await layout(page, `${name}: populated members`)
    await stableProjectRefresh(invited, project, name)
    await invited.goto(`${origin}/next/projects/${project.id}`); await invited.getByRole('heading', { name: project.name, exact: true }).waitFor()
    await invited.goto(`${origin}/next/teams`)
    const role = page.getByRole('button', { name: `更新 ${member.username} 角色`, exact: true }).locator('xpath=ancestor::form')
    await role.locator('select').selectOption('admin'); await role.getByRole('button').click(); await waitText(page, '成员角色已更新')
    check((await api(inviteeContext, `/teams/${team.id}/members/${owner.id}`, { role: 'member' }, 'PATCH')).status === 403, 'team admin cannot change owner role')
    check((await api(context, `/teams/${team.id}/members/${owner.id}`, { role: 'member' }, 'PATCH')).status === 409, 'owner downgrade requires explicit transfer')
    step = `${name}: removal and revocation`
    await invited.locator('select').first().selectOption(team.id)
    await waitText(invited, `Team ${name} 成员`)
    await invited.getByRole('button', { name: '将此团队设为当前项目范围', exact: true }).click()
    await invited.locator('select').first().selectOption(team.id)
    await waitText(invited, `Team ${name} 成员`)
    await page.getByRole('button', { name: '移除成员', exact: true }).click(); await page.getByRole('button', { name: '移除成员', exact: true }).waitFor({ state: 'hidden' })
    check((await api(inviteeContext, `/teams/${team.id}/members`)).status === 403, 'removed member immediately loses API access')
    await invited.evaluate(() => window.dispatchEvent(new Event('focus')))
    await invited.getByRole('heading', { name: `Team ${name} 成员`, exact: true }).waitFor({ state: 'hidden' })
    await invited.keyboard.press('Control+k')
    await invited.getByRole('heading', { name: '搜索与命令', exact: true }).waitFor()
    check(await invited.getByRole('button', { name: project.name, exact: true }).count() === 0, 'revoked project removed from command palette')
    await invited.getByRole('link', { name: '查看全部项目', exact: true }).click()
    await invited.getByRole('heading', { name: '项目', exact: true }).waitFor()
    check(await invited.getByText(project.name, { exact: true }).count() === 0, 'client navigation cannot reveal revoked project')
    await invited.goto(`${origin}/next/projects/${project.id}`)
    await invited.getByRole('heading', { name: '项目不存在或当前账号无权访问', exact: true }).waitFor()
    check(await invited.getByText(project.name, { exact: true }).count() === 0, 'reopened deep link cannot reveal revoked project')
    await submit(page, '发送邀请', { email: memberEmail }); await waitText(page, '邀请已创建')
    const revoked = await mailLinks(memberEmail, '/next/join')
    await page.getByRole('button', { name: '撤销邀请', exact: true }).click(); await page.getByRole('button', { name: '撤销邀请', exact: true }).waitFor({ state: 'hidden' })
    step = `${name}: revoked invite API`
    check((await api(inviteeContext, `/team-invitations/${revoked.token}/accept`, {})).status === 409, 'revoked invite cannot restore access')
    step = `${name}: ownership transfer UI`
    const successorInvite = await api(context, `/teams/${team.id}/invitations`, { email: memberEmail })
    check((await api(inviteeContext, `/team-invitations/${successorInvite.data.token}/accept`, {})).status === 200, 'fresh invitation restores membership only after acceptance')
    await page.reload(); await page.locator('select').first().selectOption(team.id)
    await submit(page, `转让所有权给 ${member.username}`, { confirmation: team.name })
    await page.getByRole('button', { name: `转让所有权给 ${member.username}`, exact: true }).waitFor({ state: 'hidden' })
    check((await api(inviteeContext, '/teams')).data.items.find(value => value.id === team.id).role === 'owner', 'explicit ownership transfer succeeds')
    step = `${name}: recovery`
    await api(context, '/auth/logout', {})
    await page.goto(`${origin}/next/login`); await page.getByRole('button', { name: '找回密码', exact: true }).click()
    await submit(page, '发送重置邮件', { email: changedEmail }); await waitText(page, '请求已受理')
    const reset = await mailLinks(changedEmail, '/next/auth/password/reset')
    await page.goto(reset.next); await mailAction(page, '/api/auth/password/reset', async () => { await submit(page, '设置新密码', { password, confirm: password }); await waitText(page, '操作已完成') })
    check((await api(context, '/auth/password/reset', { token: reset.token, password })).status === 409, 'password reset token is one-use')
    await login(page, changedEmail, password)
    step = `${name}: logout all UI`
    await page.getByRole('button', { name: '退出其他设备', exact: true }).click(); await waitText(page, '当前设备仍保持登录'); check((await api(context, '/auth/me')).status === 200, 'logout-all preserves current device by established contract'); await page.getByRole('button', { name: '撤销会话', exact: true }).click(); step = `${name}: revoke current landing`; await page.getByRole('heading', { name: '登录控制台', exact: true }).waitFor()
    check((await api(context, '/auth/me')).status === 401, 'revoking current device clears page and API identity')
    check(pageErrors.length === 0, 'no browser page errors')
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'final login page has no document overflow')
    result.viewports.push({ name, passed: true })
    await context.close(); await inviteeContext.close()
  }
  result.passed = true
} catch { result.failureStep = step; process.exitCode = 1 }
finally {
  await browser?.close(); await app?.close()
  await mkdir(resolve(evidence, '..'), { recursive: true }); await writeFile(evidence, JSON.stringify(result, null, 2))
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify(result))
}
