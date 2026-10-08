import { browserConfiguration } from './acceptance-runtime.mjs'
import { runBrowserAcceptance } from './browser-cleanup.mjs'
const configuredBrowser = browserConfiguration()
// Controlled UI regression only. This does not prove real account/Worker acceptance.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { once } from 'node:events'

const evidence = process.env.WEMUX_NEXT_EVIDENCE ?? '/tmp/wemux-ticket01-component3/browser'
await mkdir(evidence, { recursive: true })
const dist = resolve(process.env.WEMUX_NEXT_DIST_PATH ?? new URL('../dist/', import.meta.url).pathname)
let signedIn = false, mode = 'normal', worker = false
const calls = []
const projects = [{ id: 'p1', teamId: 't1', ownerId: 'u1', name: '协作平台', accessRole: 'owner', shareScope: 'owner-only' }, { id: 'p2', teamId: 't1', ownerId: 'u1', name: '长名称项目：移动端和桌面跨节点协作', accessRole: 'viewer', shareScope: 'team' }]
const account = { user: { username: '验收用户', email: null }, teamId: 't1', csrfToken: 'fixture-only', instanceAdministrator: false }
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid')
  const path = url.pathname
  function json(status, body) { response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)) }
  if (path.startsWith('/api/')) {
    calls.push(path)
    if (path === '/api/host') return json(200, { hostKind: worker ? 'local-worker' : 'cluster', contractVersion: 1, capabilities: [] })
    if (path === '/api/teams') return json(200, { items: [{ id: 't1', name: '验收团队', role: 'owner', memberCount: 1 }] })
    if (path === '/api/auth/options') return json(200, { google: { enabled: false, reason: '未配置' }, registration: { emailDelivery: false, registrationPolicy: 'closed' } })
    if (path === '/api/auth/me') return json(signedIn ? 200 : 401, signedIn ? account : {})
    if (path === '/api/auth/login') { signedIn = true; return json(200, account) }
    if (path === '/api/auth/logout') { signedIn = false; response.writeHead(204).end(); return }
    if (/^\/api\/projects\/[^/]+\/tasks$/.test(path)) return signedIn ? json(200, { items: [] }) : json(401, {})
    if (path === '/api/projects') {
      if (!signedIn) return json(401, {})
      if (mode === 'pending') return
      if (mode === 'offline') { response.destroy(); return }
      if (mode === 'expired') { await new Promise(resolve => setTimeout(resolve, 150)); signedIn = false; return json(401, {}) }
      if (mode === 'forbidden') return json(403, {})
      if (mode === 'missing') return json(404, {})
      if (mode === 'server') return json(503, {})
      if (mode === 'render') return json(200, { items: [{ ...projects[0], name: {} }] })
      return json(200, { items: mode === 'empty' ? [] : mode === 'many' ? [...projects, ...Array.from({ length: 30 }, (_, i) => ({ ...projects[0], id: `extra-${i}`, name: `滚动项目 ${i}` }))] : projects })
    }
    return json(404, {})
  }
  const file = path.startsWith('/next/assets/') || path === '/next/favicon.svg' ? resolve(dist, path.slice('/next/'.length)) : resolve(dist, 'index.html')
  if (!file.startsWith(dist + '/')) { response.writeHead(404).end(); return }
  try { const bytes = await readFile(file); response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(file)] ?? 'application/octet-stream' }).end(bytes) }
  catch { response.writeHead(404).end() }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const { chromium } = await import(configuredBrowser.module)
const browser = await chromium.launch({ executablePath: configuredBrowser.executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server', '--host-resolver-rules=MAP wemux.test 127.0.0.1'] })
const base = `http://wemux.test:${server.address().port}`
const diagnostics = [], checks = [], faviconEvents = []
let expectedRender = false, pendingLogout = false, phase = 'scenarios', pageNumber = 0
function observe(page) {
  const pageId = ++pageNumber, requests = new WeakMap(), origins = new WeakMap()
  let requestNumber = 0
  const record = (event, details = {}) => faviconEvents.push({ sequence: faviconEvents.length + 1, pageId, phase, mode, event, ...details })
  const isFavicon = request => new URL(request.url()).pathname === '/next/favicon.svg'
  page.on('request', request => {
    origins.set(request, { phase, mode, path: new URL(request.url()).pathname })
    if (request.isNavigationRequest()) record('navigation-request', { path: new URL(request.url()).pathname })
    if (isFavicon(request)) { requests.set(request, ++requestNumber); record('favicon-request', { requestId: requestNumber }) }
  })
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) record('navigation-committed', { path: new URL(frame.url()).pathname }) })
  page.on('close', () => record('page-close'))
  page.on('requestfinished', request => { if (isFavicon(request)) record('favicon-finished', { requestId: requests.get(request) }) })
  const statuses = new WeakMap()
  page.on('response', response => {
    statuses.set(response.request(), response.status())
    if (isFavicon(response.request())) record('favicon-response', { requestId: requests.get(response.request()), status: response.status(), contentType: response.headers()['content-type'] })
  })
  page.on('pageerror', error => diagnostics.push({ type: 'pageerror', expected: expectedRender && mode === 'render' && /name\.toLowerCase is not a function/.test(error.message), message: error.message }))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const { url } = message.location(), path = url ? new URL(url).pathname : ''
    const expectedHttp = /^Failed to load resource: the server responded with a status of (401|403|404|503) \(/.test(message.text())
      && ((path === '/api/auth/me' && message.text().includes('401')) || (path === '/api/projects' && ['expired', 'forbidden', 'missing', 'server'].includes(mode)))
    const expectedNetwork = mode === 'offline' && path === '/api/projects' && message.text() === 'Failed to load resource: net::ERR_EMPTY_RESPONSE'
    const expectedException = expectedRender && mode === 'render' && path.startsWith('/next/assets/') && /name\.toLowerCase is not a function/.test(message.text())
    diagnostics.push({ type: 'console', expected: expectedHttp || expectedNetwork || expectedException, message: message.text(), url })
  })
  page.on('requestfailed', request => {
    const path = new URL(request.url()).pathname, status = statuses.get(request), reason = request.failure()?.errorText
    if (isFavicon(request)) record('favicon-failed', { requestId: requests.get(request), status: status ?? null, reason })
    // The shared transport deliberately aborts its identity scope after a 401 or completed logout.
    const identityRetired = reason === 'net::ERR_ABORTED' && ((status === 401 && ['/api/auth/me', '/api/projects'].includes(path)) || (status === 204 && path === '/api/auth/logout'))
    // This fixture deliberately leaves the project read unanswered, then logs out.
    // Only that known pending GET is expected to be cancelled by the test action.
    const cancelledByPendingLogout = pendingLogout && phase === 'scenarios' && mode === 'pending' && path === '/api/projects' && request.method() === 'GET' && status === undefined && reason === 'net::ERR_ABORTED'
    const cancelledByExpiry = origins.get(request)?.mode === 'expired' && mode === 'expired' && path === '/api/projects' && request.method() === 'GET' && reason === 'net::ERR_ABORTED' && status === undefined && !signedIn
    const expectedOffline = origins.get(request)?.mode === 'offline' && mode === 'offline' && path === '/api/projects' && request.method() === 'GET' && reason === 'net::ERR_EMPTY_RESPONSE'
    diagnostics.push({ type: 'requestfailed', expected: expectedOffline || identityRetired || cancelledByPendingLogout || cancelledByExpiry, path, status, reason, identityRetired, cancelledByPendingLogout, cancelledByExpiry, expectedOffline, phase, mode, origin: origins.get(request) })
  })
}
await runBrowserAcceptance({ runScenarios: async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' }); observe(page)
  await page.goto(`${base}/next/projects/p1?from=shared#details`)
  await page.getByRole('heading', { name: '登录控制台' }).waitFor()
  assert.equal((await page.request.get(`http://127.0.0.1:${server.address().port}/api/projects`)).status(), 401, 'anonymous fixture must not serve Project data')
  assert.equal(await page.evaluate(() => window.isSecureContext), false)
  await page.getByLabel('邮箱或用户名').fill('fixture')
  await page.getByLabel('密码', { exact: true }).fill('fixture-password')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('heading', { name: '协作平台', exact: true }).waitFor()
  assert.equal(new URL(page.url()).search, '?from=shared'); assert.equal(new URL(page.url()).hash, '#details')
  await page.getByRole('button', { name: '复制项目链接' }).click()
  await page.getByRole('status').filter({ hasText: '请按 Ctrl+C 或长按复制' }).waitFor()
  assert.match(await page.evaluate(() => window.getSelection()?.toString()), /\/next\/projects\/p1$/)
  checks.push('HTTP insecure context: login and randomId navigation succeed; copy selects text and explains manual fallback')
  await page.getByRole('button', { name: '返回项目列表' }).click()
  await page.getByRole('heading', { name: '项目', exact: true }).waitFor()
  await page.screenshot({ path: `${evidence}/desktop-projects.png`, fullPage: true })
  const separator = page.getByRole('separator', { name: '调整侧栏宽度' })
  await separator.focus(); const before = Number(await separator.getAttribute('aria-valuenow')); await page.keyboard.press('ArrowRight')
  assert.equal(Number(await separator.getAttribute('aria-valuenow')), before + 16)
  await page.getByRole('searchbox', { name: '搜索项目' }).fill('不存在')
  await page.getByRole('heading', { name: '没有匹配的项目' }).waitFor()
  await page.getByRole('button', { name: '清除搜索' }).click()
  await page.keyboard.press('Control+k')
  await page.getByRole('dialog').getByLabel('搜索可访问的项目').fill('协作平台')
  await page.getByRole('dialog').getByRole('button', { name: '协作平台', exact: true }).click()
  await page.getByRole('heading', { name: '协作平台', exact: true }).waitFor()
  await page.goBack(); await page.getByRole('heading', { name: '项目', exact: true }).waitFor()
  await page.reload(); await page.getByRole('link', { name: /协作平台/ }).waitFor()
  mode = 'many'; await page.reload(); await page.getByRole('link', { name: /滚动项目 29/ }).waitFor()
  await page.locator('#main-content').evaluate(element => { element.scrollTop = 650 })
  await page.waitForFunction(() => document.getElementById('main-content').scrollTop === 650)
  await page.getByRole('link', { name: /滚动项目 5 / }).click()
  await page.getByRole('heading', { name: '滚动项目 5', exact: true }).waitFor()
  await page.goBack(); await page.getByRole('heading', { name: '项目', exact: true }).waitFor()
  await page.waitForFunction(() => document.getElementById('main-content').scrollTop === 650)
  mode = 'normal'
  checks.push('Desktop keyboard resize, project search, command dialog, deep link, refresh, back and per-entry scroll restoration')
  await page.goto(`${base}/next/not-a-page`); await page.getByRole('heading', { name: '页面不存在' }).waitFor()
  await page.getByRole('button', { name: '返回项目列表' }).click()
  await page.goto(`${base}/next/projects/hidden`); await page.getByRole('heading', { name: '项目不存在或当前账号无权访问' }).waitFor()
  for (const [fault, heading] of [['forbidden', '无权访问'], ['missing', '资源不存在'], ['offline', '网络连接失败'], ['server', '服务暂时不可用']]) {
    mode = fault
    await page.goto(`${base}/next/projects`); await page.getByRole('heading', { name: heading, exact: true }).waitFor()
    mode = 'normal'; await page.getByRole('button', { name: '重试' }).click(); await page.getByRole('link', { name: /协作平台/ }).waitFor()
  }
  mode = 'empty'; await page.reload(); await page.getByRole('heading', { name: '还没有可访问的项目' }).waitFor()
  await page.waitForLoadState('networkidle')
  mode = 'expired'; await page.reload(); await page.getByRole('heading', { name: '登录控制台' }).waitFor(); await page.getByRole('status').filter({ hasText: '过期' }).waitFor()
  mode = 'normal'; await page.getByLabel('邮箱或用户名').fill('fixture'); await page.getByLabel('密码', { exact: true }).fill('fixture-password'); await page.getByRole('button', { name: '登录', exact: true }).click(); await page.getByRole('link', { name: /协作平台/ }).waitFor()
  await page.getByRole('button', { name: '退出登录' }).click(); await page.getByRole('heading', { name: '登录控制台' }).waitFor(); assert.equal(signedIn, false)
  assert.equal((await page.request.get(`http://127.0.0.1:${server.address().port}/api/projects`)).status(), 401, 'logout must revoke Project fixture access')
  checks.push('404 route, concealed project, HTTP403/404/network/503 retry, empty, expiry, logout')
  mode = 'pending'
  // Emulate an in-app history transition while Login remains mounted. A full goto
  // would mask a stale one-time oauth_error initializer on the existing login page.
  await page.evaluate(target => {
    window.history.pushState({ ...window.history.state, wemuxKey: 'oauth-navigation-fixture', wemuxIndex: (window.history.state?.wemuxIndex ?? 0) + 1 }, '', target)
    window.dispatchEvent(new Event('wemux:navigate'))
  }, `/next/login?oauth_error=state_replayed&returnTo=${encodeURIComponent('/next/projects/p1?from=oauth#details')}`)
  await page.getByRole('alert').filter({ hasText: '登录状态已被使用' }).waitFor()
  await page.waitForFunction(() => !new URLSearchParams(location.search).has('oauth_error'))
  await page.getByLabel('邮箱或用户名').fill('fixture'); await page.getByLabel('密码', { exact: true }).fill('fixture-password')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('button', { name: '退出登录' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '退出登录' }).isDisabled(), false)
  pendingLogout = true
  await page.getByRole('button', { name: '退出登录' }).click()
  await page.getByRole('heading', { name: '登录控制台' }).waitFor()
  assert.equal(signedIn, false)
  await page.goBack(); await page.getByRole('heading', { name: '登录控制台' }).waitFor()
  pendingLogout = false
  mode = 'normal'
  checks.push('In-app failed OAuth return clears error, preserves navigation state and permits logout during pending projects')
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' }); observe(mobile)
  await mobile.goto(`${base}/next/login?returnTo=${encodeURIComponent('/next/projects/p1?from=login#details')}`)
  await mobile.getByRole('heading', { name: '登录控制台' }).waitFor(); await mobile.screenshot({ path: `${evidence}/mobile-login.png`, fullPage: true })
  await mobile.getByLabel('邮箱或用户名').fill('fixture'); await mobile.getByLabel('密码', { exact: true }).fill('fixture-password'); await mobile.getByRole('button', { name: '登录', exact: true }).tap()
  await mobile.getByRole('heading', { name: '协作平台', exact: true }).waitFor(); assert.equal(new URL(mobile.url()).search, '?from=login')
  await mobile.getByRole('button', { name: '打开导航' }).tap(); await mobile.getByRole('dialog').getByRole('navigation').waitFor()
  const focusable = mobile.getByRole('dialog').locator('button:not(:disabled), a[href], input:not(:disabled), summary, [tabindex="0"]')
  const count = await focusable.count()
  await focusable.first().focus()
  for (let i = 0; i < count; i++) {
    assert.equal(await focusable.nth(i).evaluate(element => element === document.activeElement), true, `mobile item ${i} must be reachable`)
    await mobile.keyboard.press('Tab')
  }
  assert.equal(await focusable.first().evaluate(element => element === document.activeElement), true)
  await mobile.keyboard.press('Shift+Tab')
  assert.equal(await focusable.last().evaluate(element => element === document.activeElement), true)
  assert.equal(await focusable.last().evaluate(element => element.tagName), 'SUMMARY')
  await mobile.keyboard.press('Enter')
  assert.equal(await mobile.getByRole('dialog').locator('details').evaluate(element => element.open), true)
  for (let i = count - 1; i >= 0; i--) {
    assert.equal(await focusable.nth(i).evaluate(element => element === document.activeElement), true)
    await mobile.keyboard.press('Shift+Tab')
  }
  assert.equal(await focusable.last().evaluate(element => element === document.activeElement), true)
  await mobile.keyboard.press('Escape'); assert.equal(await mobile.getByRole('button', { name: '打开导航' }).evaluate(element => element === document.activeElement), true)
  await mobile.getByRole('button', { name: '打开导航' }).tap(); await mobile.getByRole('dialog').getByRole('link', { name: '项目', exact: true }).tap(); await mobile.getByRole('heading', { name: '项目', exact: true }).waitFor()
  await mobile.goBack(); await mobile.getByRole('heading', { name: '协作平台', exact: true }).waitFor()
  assert.equal(new URL(mobile.url()).search, '?from=login'); assert.equal(new URL(mobile.url()).hash, '#details')
  await mobile.reload(); await mobile.getByRole('heading', { name: '协作平台', exact: true }).waitFor()
  await mobile.goForward(); await mobile.getByRole('heading', { name: '项目', exact: true }).waitFor()
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await mobile.screenshot({ path: `${evidence}/mobile-projects.png`, fullPage: true })
  checks.push('Mobile login return target, drawer touch/Tab trap/Escape focus return, navigation, refresh/back/forward, no horizontal overflow')
  expectedRender = true; mode = 'render'; await page.goto(`${base}/next/projects`); await page.getByRole('heading', { name: '页面出现异常' }).waitFor()
  mode = 'normal'; await page.getByRole('button', { name: '重新加载页面' }).click(); await page.getByRole('link', { name: /协作平台/ }).waitFor(); expectedRender = false
  checks.push('Intentional render exception is distinct and reload recovers (injected malformed fixture only)')
  worker = true; const start = calls.length; await page.goto(`${base}/next/projects`); await page.getByRole('heading', { name: '当前是独立 Worker' }).waitFor(); assert.deepEqual(calls.slice(start), ['/api/host'])
  checks.push('Worker host branch makes no cluster credential request; not Ticket13 acceptance')
  phase = 'final-check'
  // APIRequestContext uses Node DNS, not Chromium's wemux.test resolver rule.
  const favicon = await page.request.get(`http://127.0.0.1:${server.address().port}/next/favicon.svg`)
  faviconEvents.push({ sequence: faviconEvents.length + 1, phase, event: 'favicon-serving-check', status: favicon.status(), contentType: favicon.headers()['content-type'] })
  assert.equal(favicon.status(), 200)
  assert.match(favicon.headers()['content-type'], /^image\/svg\+xml\b/)
  assert.deepEqual(await favicon.body(), await readFile(resolve(dist, 'favicon.svg')))
},
  closeBrowser: async () => {
    phase = 'teardown'
    faviconEvents.push({ sequence: faviconEvents.length + 1, phase, event: 'browser-close-start' })
    await browser.close()
  },
  closeServer: async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    faviconEvents.push({ sequence: faviconEvents.length + 1, phase, event: 'server-close-complete' })
  },
  verifyDiagnostics: () => assert.deepEqual(diagnostics.filter(item => !item.expected), []),
  evidence: [
    { stage: 'favicon-events', write: () => writeFile(`${evidence}/favicon-events.json`, JSON.stringify(faviconEvents, null, 2)) },
    { stage: 'diagnostics-evidence', write: () => writeFile(`${evidence}/diagnostics.json`, JSON.stringify(diagnostics, null, 2)) },
  ],
  writeResult: ({ passed, failures }) => writeFile(`${evidence}/result.json`, JSON.stringify({
    kind: 'controlled-fixture-only', dist, distKind: process.env.WEMUX_NEXT_DIST_PATH ? 'explicit-dist-override' : 'repository-dist', passed, checks, diagnostics,
    failures: failures.map(({ stage, error }) => ({ stage, message: String(error), stack: error?.stack })),
  }, null, 2)),
})
console.log(`PASS ${checks.length} browser scenario groups; diagnostics captured, zero unexpected errors. Evidence: ${evidence}`)
