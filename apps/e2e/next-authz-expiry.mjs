/** Source-only browser fixture. No build/dist, deployed credentials, Worker or Runtime.
 * Start --serve via setsid nohup node --import tsx ... & disown; then run --browser.
 * Explicit PLAYWRIGHT_CORE_PATH (1.61.0) and PLAYWRIGHT_CHROMIUM_PATH (1228) required.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer as createTcpServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createWemuxServer } from '../server/src/server.ts'
import { launchAcceptanceBrowser } from '../web-next/tests/acceptance-runtime.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const evidence = '/tmp/wemux-ticket01-authz-expiry'
const email = 'ticket01-owner@example.test', password = 'ticket01-synthetic-password'
const ttlMs = 12000
await mkdir(evidence, { recursive: true, mode: 0o700 })
if (process.argv.includes('--serve')) {
  // Select an unused dynamic port before constructing mail links. Binding failure is fatal.
  const reservation = createTcpServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  assert.notEqual(port, 8004)
  await new Promise(resolve => reservation.close(resolve))
  process.env.WEMUX_ADMIN_EMAILS = email
  process.env.WEMUX_MAIL_OUTBOX = join(evidence, 'outbox')
  process.env.WEMUX_SMTP_FROM = 'Wemux Test <noreply@example.test>'
  process.env.WEMUX_PUBLIC_URL = `http://127.0.0.1:${port}`
  const app = createWemuxServer({ databasePath: join(evidence, `server-${process.pid}.sqlite`), adminSessionTtlMs: ttlMs, google: {} })
  const { createServer } = await import('vite')
  const vite = await createServer({
    configFile: resolve(root, 'web-next/vite.config.ts'),
    cacheDir: join(evidence, 'vite-cache'),
    resolve: { alias: { '@wemux/web-client': resolve(root, '../packages/web-client/src/index.ts') } },
    server: { middlewareMode: true, hmr: false },
  })
  const handlers = app.server.listeners('request')
  app.server.removeAllListeners('request')
  app.server.on('request', (request, response) => {
    if (request.url?.startsWith('/api/')) { for (const handler of handlers) handler.call(app.server, request, response) }
    else vite.middlewares(request, response, () => { response.writeHead(404).end() })
  })
  const origin = await app.listen(port)
  await writeFile(join(evidence, 'fixture.json'), JSON.stringify({ origin, pid: process.pid, ttlMs, mode: 'vite-source-middleware-not-dist' }))
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await vite.close(); await app.close()
    await writeFile(join(evidence, 'fixture-closed.json'), JSON.stringify({ pid: process.pid, closed: true }))
  }
  process.on('SIGTERM', () => { void close().then(() => process.exit(0), () => process.exit(1)) })
  process.on('SIGINT', () => { void close().then(() => process.exit(0), () => process.exit(1)) })
} else if (process.argv.includes('--browser')) {
  const { origin } = JSON.parse(await readFile(join(evidence, 'fixture.json'), 'utf8'))
  const checks = [], screenshots = [], diagnostics = []
  let browser, page, step = 'setup', passed = false
  const check = (ok, label) => { assert.ok(ok, label); checks.push(label) }
  const api = async (path, { method = 'GET', data, cookie, csrf } = {}) => {
    const response = await fetch(origin + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
    const body = response.status === 204 ? null : await response.json()
    return { response, body }
  }
  const login = async user => {
    const result = await api('/auth/login', { method: 'POST', data: { login: user, password } })
    assert.equal(result.response.status, 200)
    return { cookie: result.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), csrf: result.body.csrfToken, account: result.body }
  }
  const ownerApi = async (path, method = 'GET', data) => {
    const credentials = await login(email)
    const result = await api(path, { ...credentials, method, data })
    assert.ok(result.response.ok, `${method} ${path}: ${result.response.status}`)
    return result.body
  }
  const register = async (user, displayName) => {
    const before = new Set(await readdir(join(evidence, 'outbox')).catch(() => []))
    const result = await api('/auth/register', { method: 'POST', data: { email: user, displayName, password } })
    assert.equal(result.response.status, 202)
    const mails = (await readdir(join(evidence, 'outbox'))).filter(name => !before.has(name) && name.endsWith('.eml'))
    assert.equal(mails.length, 1)
    const eml = await readFile(join(evidence, 'outbox', mails[0]), 'utf8')
    const decoded = Buffer.from(eml.split(/\r?\n\r?\n/).slice(1).join('\n').replace(/\s/g, ''), 'base64').toString('utf8')
    const link = decoded.match(/https?:\/\/[^\s]+\/auth\/verify-email\?token=[^\s]+/)?.[0]
    assert.ok(link, 'verification link decoded from actual .eml')
    assert.equal(new URL(link).origin, origin)
    const verified = await api('/auth/email/verify', { method: 'POST', data: { token: new URL(link).searchParams.get('token') } })
    assert.equal(verified.response.status, 200)
    check(true, `registered and verified local outbox: ${displayName}`)
  }
  const screenshot = async name => { const path = join(evidence, `${name}.png`); await page.screenshot({ path, fullPage: true }); screenshots.push(path) }
  const uiLogin = async user => {
    await page.getByRole('heading', { name: '登录控制台' }).waitFor()
    await page.getByLabel('邮箱或用户名', { exact: true }).fill(user)
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  const probe = async action => page.evaluate(async action => {
    const { application } = await import('/next/src/App.tsx')
    if (action === 'load') await application.loadProjects()
    if (action === 'recheck') await application.revalidateAccess()
    if (action === 'hold') { window.authProbe.armed = true; void application.loadProjects() }
  }, action)
  const noVisible = async names => { for (const name of names) assert.equal(await page.getByText(name, { exact: true }).count(), 0) }
  const expired = async (name, hidden) => {
    await page.getByRole('heading', { name: '登录控制台' }).waitFor()
    await page.getByText('登录会话已过期或已失效，请重新登录。登录后将重新核验当前页面的访问权限。', { exact: true }).waitFor()
    await noVisible(hidden)
    check(!(await page.context().cookies()).some(cookie => cookie.name === 'wemux_login_session'), `${name}: invalid cookie removed`)
    const before = page.url()
    await delay(300)
    check(page.url() === before, `${name}: no redirect loop, target retained`)
    await screenshot(name)
  }
  try {
    await register(email, '授权验收管理员')
    await ownerApi('/settings/registration-policy', 'PATCH', { policy: 'open' })
    browser = await launchAcceptanceBrowser()
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      step = `${name}: registration`
      const user = `ticket01-${name}@example.test`
      await register(user, `授权验收${name}`)
      const credentials = await login(user)
      const invite = await ownerApi('/teams/default-team/invitations', 'POST', { email: user })
      assert.equal((await api(`/team-invitations/${invite.token}/accept`, { ...credentials, method: 'POST', data: {} })).response.status, 200)
      const project = await ownerApi('/projects', 'POST', { name: `获权项目-${name}`, teamId: 'default-team', requestId: `visible-${name}` })
      await ownerApi(`/projects/${project.id}/access`, 'PATCH', { shareScope: 'team' })
      const hidden = await ownerApi('/projects', 'POST', { name: `隐藏项目-${name}`, teamId: 'default-team', requestId: `hidden-${name}` })
      const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
      await context.addInitScript(() => {
        window.authProbe = { armed: false, held: false, released: false }
        const json = Response.prototype.json
        Response.prototype.json = async function (...args) {
          const body = await json.apply(this, args)
          if (new URL(this.url).pathname === '/api/projects' && this.ok && window.authProbe.armed) {
            window.authProbe.armed = false; window.authProbe.held = true
            await new Promise(resolve => { window.authProbe.release = resolve })
            window.authProbe.released = true
          }
          return body
        }
      })
      page = await context.newPage(); page.setDefaultTimeout(25000)
      page.on('pageerror', () => diagnostics.push({ name, kind: 'pageerror' }))
      const target = `/next/projects/${project.id}?from=authz#retained`
      await page.goto(origin + target)
      await uiLogin(user)
      await page.getByRole('heading', { name: project.name, exact: true }).waitFor()
      await noVisible([hidden.name])
      const me = await (await context.request.get(origin + '/api/auth/me')).json()
      // Filtered list, raw response bytes and security headers for hidden/missing resources.
      const listed = await (await context.request.get(origin + '/api/projects')).json()
      check(listed.items.some(item => item.id === project.id) && !listed.items.some(item => item.id === hidden.id), `${name}: authorized list excludes hidden project`)
      const denied = await context.request.get(origin + `/api/projects/${hidden.id}`)
      const absent = await context.request.get(origin + '/api/projects/not-existing-authz')
      check(denied.status() === 404 && absent.status() === 404, `${name}: hidden and nonexistent both return 404`)
      check((await denied.body()).equals(await absent.body()), `${name}: hidden and nonexistent response bodies are byte-identical`)
      const securityHeaders = response => response.headersArray()
        .filter(({ name }) => ['content-type', 'cache-control', 'set-cookie', 'set-cookie2', 'cookie'].includes(name.toLowerCase()))
        .map(({ name, value }) => ({ name: name.toLowerCase(), value }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.value.localeCompare(b.value))
      step = `${name}: hidden/missing security headers`
      assert.deepEqual(securityHeaders(denied), securityHeaders(absent))
      check(true, `${name}: Content-Type, Cache-Control and cookie-related response headers match`)
      await screenshot(`${name}-authorized`)

      step = `${name}: revoke while authorized response is in flight`
      await probe('hold')
      await page.waitForFunction(() => window.authProbe.held)
      const sameUser = await login(user)
      assert.equal((await api(`/auth/sessions/${me.session.id}`, { ...sameUser, method: 'DELETE' })).response.status, 204)
      await probe('load') // Actual new request receives 401; old successful JSON is still held.
      await expired(`${name}-revoked`, [project.name, hidden.name])
      await page.evaluate(() => window.authProbe.release())
      await page.waitForFunction(() => window.authProbe.released)
      await noVisible([project.name, hidden.name])
      check(true, `${name}: late authorized result cannot restore retired identity`)
      await page.reload(); await expired(`${name}-revoked-reload`, [project.name, hidden.name])

      step = `${name}: natural TTL and pending request`
      await uiLogin(user)
      await page.getByRole('heading', { name: project.name, exact: true }).waitFor()
      const cookie = (await context.cookies()).find(cookie => cookie.name === 'wemux_login_session')
      assert.ok(cookie)
      const account = await (await context.request.get(origin + '/api/auth/me')).json()
      let pending, release
      const reached = new Promise(resolve => { pending = resolve })
      const barrier = new Promise(resolve => { release = resolve })
      await page.route('**/api/projects?*', async route => { pending(); await barrier; await route.continue() }, { times: 1 })
      const request = probe('load')
      await reached
      await delay(Math.max(0, Date.parse(account.session.idleExpiresAt) - Date.now()) + 100)
      const oldCookie = await api('/projects', { cookie: `wemux_login_session=${cookie.value}` })
      check(oldCookie.response.status === 401 && oldCookie.body.error.code === 'authentication_required', `${name}: natural TTL rejects original cookie, not a mocked 401`)
      release(); await request
      await expired(`${name}-expired`, [project.name, hidden.name])
      await page.reload(); await expired(`${name}-expired-reload`, [project.name, hidden.name])
      check(page.url().endsWith(target), `${name}: expired refresh preserves query/hash deep link`)

      step = `${name}: project authorization removed`
      await uiLogin(user)
      await page.getByRole('heading', { name: project.name, exact: true }).waitFor()
      await ownerApi(`/teams/default-team/members/${credentials.account.user.id}`, 'DELETE')
      await probe('recheck')
      await page.getByRole('heading', { name: '项目不存在或当前账号无权访问' }).waitFor()
      await noVisible([project.name, hidden.name])
      check(await page.getByRole('heading', { name: '登录控制台' }).count() === 0, `${name}: scope revocation is not session expiry`)
      await screenshot(`${name}-permission-removed`)
      await page.reload()
      await page.getByRole('heading', { name: '项目不存在或当前账号无权访问' }).waitFor()
      await noVisible([project.name, hidden.name])
      const deniedAfter = await context.request.get(origin + `/api/projects/${project.id}`)
      check(deniedAfter.status() === 404, `${name}: revoked membership denied by real API after refresh`)
      const logoutMe = await (await context.request.get(origin + '/api/auth/me')).json()
      assert.equal((await context.request.post(origin + '/api/auth/logout', { headers: { 'x-csrf-token': logoutMe.csrfToken } })).status(), 204)
      await context.close()
    }
    check(diagnostics.length === 0, 'zero uncaught browser exceptions')
    passed = true
  } catch {
    if (page && !page.isClosed()) await screenshot('failure').catch(() => {})
    // Never persist Playwright exceptions; their call logs can contain form secrets.
  } finally {
    await browser?.close().catch(() => { passed = false; diagnostics.push({ kind: 'browser-close-failed' }) })
    await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed, step, mode: 'source-middleware-not-candidate', checks, checkCount: checks.length, screenshots, screenshotCount: screenshots.length, diagnostics }, null, 2))
    console.log(JSON.stringify({ passed, step, checks: checks.length, screenshots: screenshots.length }))
    process.exitCode = passed ? 0 : 1
  }
} else throw Error('Choose --serve or --browser')
