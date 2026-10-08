// Read-only project acceptance against the existing deployed instance. No model calls or data seeding.
// WEMUX_NEXT_BASE_URL=http(s)://existing-host:port
// WEMUX_NEXT_LOGIN_FILE=/protected/path.json containing { "login": ..., "password": ... }
// WEMUX_NEXT_PROJECT_ID=an-existing-authorized-project-id
// Optional WEMUX_NEXT_EVIDENCE=/tmp/... (screenshots contain real project names; keep private).
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { readAcceptanceCredentials } from './real-instance-credentials.mjs'
import { browserConfiguration, launchAcceptanceBrowser, recordAcceptanceFailure, finishAcceptance } from './acceptance-runtime.mjs'
const evidence = process.env.WEMUX_NEXT_EVIDENCE ?? '/tmp/wemux-next-real-instance'
const results = [], diagnostics = []
let currentStep = 'initialization', browser, passed = false, failure
try {
  browserConfiguration()
const base = new URL(process.env.WEMUX_NEXT_BASE_URL ?? '').origin
const projectId = process.env.WEMUX_NEXT_PROJECT_ID
if (!projectId) throw Error('An existing project is required; do not seed another instance.')
// WEMUX_NEXT_LOGIN_STDIN=1 accepts a private JSON pipe instead of a credential file.
const credentials = await readAcceptanceCredentials()

await mkdir(evidence, { recursive: true, mode: 0o700 })
browser = await launchAcceptanceBrowser()
const safeLocation = value => { try { const path = new URL(value).pathname; return ['/api/auth/me', '/api/projects', '/api/auth/logout', '/favicon.ico'].includes(path) ? path : 'other' } catch { return 'unknown' } }


  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile })
    const page = await context.newPage()
    const statuses = new WeakMap()
    page.on('response', response => statuses.set(response.request(), response.status()))
    page.on('request', request => { if (new URL(request.url()).pathname === '/favicon.ico' && currentStep === 'anonymous-entry') diagnostics.push({ type: 'root-favicon-request', mobile, expected: false }) })
    page.on('pageerror', () => diagnostics.push({ type: 'pageerror', mobile, step: currentStep, message: 'browser-pageerror', expected: false }))
    page.on('console', message => { if (message.type() === 'error') { const location = message.location(); const path = safeLocation(location.url); diagnostics.push({ type: 'console', mobile, step: currentStep, message: 'browser-console-error', location: { path, line: location.lineNumber, column: location.columnNumber }, expected: /401/.test(message.text()) && currentStep === 'anonymous-entry' && path === '/api/auth/me' }) } })
    page.on('requestfailed', request => {
      const path = new URL(request.url()).pathname, status = statuses.get(request)
      const retired = request.failure()?.errorText === 'net::ERR_ABORTED' && ((status === 401 && ['/api/auth/me', '/api/projects'].includes(path)) || (status === 204 && path === '/api/auth/logout'))
      diagnostics.push({ type: 'requestfailed', mobile, status, expected: retired })
    })
    const target = `/next/projects/${encodeURIComponent(projectId)}?acceptance=return#summary`
    currentStep = 'anonymous-entry'
    await page.goto(`${base}${target}`)
    await page.getByRole('heading', { name: '登录控制台' }).waitFor()
    currentStep = 'fill-login'
    await page.getByLabel('邮箱或用户名').fill(credentials.login)
    currentStep = 'fill-password'
    await page.getByLabel('密码', { exact: true }).fill(credentials.password)
    const projectsResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects' && response.ok())
    currentStep = 'login'
    await page.getByRole('button', { name: '登录', exact: true }).click()
    const items = (await (await projectsResponse).json()).items
    const project = items.find(item => item.id === projectId)
    assert.ok(project, 'Specified existing project must be in the authorized API list')
    await page.getByRole('heading', { name: project.name, exact: true }).waitFor()
    assert.equal(new URL(page.url()).pathname, new URL(target, base).pathname)
    assert.equal(new URL(page.url()).search, '?acceptance=return')
    assert.equal(new URL(page.url()).hash, '#summary')
    currentStep = 'project-navigation'
    await page.reload(); await page.getByRole('heading', { name: project.name, exact: true }).waitFor()
    await page.getByRole('button', { name: '返回项目列表' }).click()
    await page.getByRole('heading', { name: '项目', exact: true }).waitFor()
    await page.getByRole('link', { name: new RegExp(project.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().waitFor()
    await page.goBack(); await page.getByRole('heading', { name: project.name, exact: true }).waitFor()
    await page.screenshot({ path: `${evidence}/${mobile ? 'mobile' : 'desktop'}-project.png`, fullPage: true })
    if (!await page.evaluate(() => isSecureContext)) {
      await page.getByRole('button', { name: '复制项目链接' }).click()
      await page.getByRole('status').filter({ hasText: '请按 Ctrl+C 或长按复制' }).waitFor()
    }
    // Ticket01 gates only the new frontend; legacy UI is a separate historical diagnostic.
    currentStep = 'project-list'
    await page.goto(`${base}/next/projects`); await page.getByRole('heading', { name: '项目', exact: true }).waitFor()
    if (mobile) await page.getByRole('button', { name: '打开导航' }).click()
    currentStep = 'logout'
    await page.getByRole('button', { name: '退出登录' }).click()
    await page.getByRole('heading', { name: '登录控制台' }).waitFor()
    currentStep = 'anonymous-entry'
    await page.reload(); await page.getByRole('heading', { name: '登录控制台' }).waitFor()
    results.push({ viewport: mobile ? 'mobile' : 'desktop', realAuthorizedProject: true, login: true, refresh: true, back: true, logout: true })
    await context.close()
  }
  assert.deepEqual(diagnostics.filter(entry => !entry.expected), [])
  passed = true


} catch {
  const state = { passed, failure }
  recordAcceptanceFailure(state, currentStep)
  passed = state.passed; failure = state.failure
} finally {
  const state = { kind: 'real-existing-instance', passed, failure, results, diagnostics }
  process.exitCode = await finishAcceptance(state, [() => browser?.close()], async value => {
    await mkdir(evidence, { recursive: true, mode: 0o700 })
    await writeFile(`${evidence}/result.json`, JSON.stringify(value, null, 2), { mode: 0o600 })
  })
  passed = state.passed
  if (!passed) console.error('Acceptance failed (details withheld).')
}
if (passed) console.log('PASS real existing-instance new-only desktop/mobile project acceptance. No model calls.')
