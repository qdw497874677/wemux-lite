// Ticket 07 真实浏览器验收：Google 按钮 → 授权跳转 → 回调换会话 → 再登录/邮箱冲突/策略拒绝。
// 与 Ticket 04/05 的脚本同一套约定：playwright-core 故意不是仓库依赖，用环境变量指到已有安装。
//   WEMUX_KEEP_SHOTS=1 node --import tsx apps/server/scripts/verify-google-login.mjs
// 可覆盖：WEMUX_PLAYWRIGHT（playwright-core 入口）、WEMUX_CHROME（Chromium 可执行文件）、WEMUX_KEEP_SHOTS=1（保留截图）。
//
// Google 只有两个网络端点被替身替换，其余都是生产代码路径：
//   1. 授权页：浏览器访问 accounts.google.com 时由 Playwright 路由改写到本地自动同意端点；
//   2. 令牌端点与 JWKS：同一台本地替身服务提供，ID token 由真实 RS256 密钥签名。
// 服务端仍跑真实的 `createGoogleTokenVerifier`（jose 验签、issuer/audience/算法白名单、PKCE、nonce），信任边界不替换。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeGoogle, routeGoogleAuthorize } from './lib/fake-google.mjs'

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(serverRoot, '../..')
const webDist = join(repositoryRoot, 'apps/web/dist')
const playwrightEntry = process.env.WEMUX_PLAYWRIGHT ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs'
const chromePath = process.env.WEMUX_CHROME ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'

const clientId = 'verify-google-client-id.apps.googleusercontent.com'
const clientSecret = 'verify-google-client-secret'
const adminEmail = 'verify-admin@gmail.com'
const adminPassword = 'verify-admin-password-value'

if (!existsSync(join(webDist, 'index.html'))) throw new Error(`缺少 Web 构建产物：${webDist}。先运行 npm run build:web。`)
const { chromium } = await import(playwrightEntry)

const workspace = await mkdtemp(join(tmpdir(), 'wemux-google-login-'))
const screenshotDir = process.env.WEMUX_KEEP_SHOTS ? join(workspace, 'screenshots') : workspace
await mkdir(screenshotDir, { recursive: true })

const freePort = async () => {
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}

/** 脚本内的最小 HTTP 客户端：Cookie 罐 + CSRF，只用于准备实例状态（认领管理员、切注册策略）。 */
function createClient(base) {
  const jar = new Map()
  const call = async (path, options = {}) => {
    const headers = { ...(options.headers ?? {}) }
    if (jar.size > 0) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    if (options.method && options.method !== 'GET') headers.origin = base
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.csrf) headers['x-csrf-token'] = options.csrf
    const response = await fetch(`${base}/api${path}`, { method: options.method ?? (options.body === undefined ? 'GET' : 'POST'), headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
    for (const cookie of response.headers.getSetCookie()) { const [pair] = cookie.split(';'); const index = pair.indexOf('='); jar.set(pair.slice(0, index), pair.slice(index + 1)) }
    const text = await response.text()
    let data = null
    try { data = text.length > 0 ? JSON.parse(text) : null } catch { data = text }
    return { status: response.status, data }
  }
  const signIn = async ({ email, password }) => {
    const response = await call('/auth/login', { body: { username: email, password } })
    assert.equal(response.status, 200, `登录失败：${JSON.stringify(response.data)}`)
    const me = await call('/auth/me')
    return { csrf: me.data?.csrfToken, account: me.data }
  }
  return { call, signIn }
}

const results = []
const startServer = async ({ google, googleVerifier, port, administratorEmails = [] }) => {
  const { createWemuxServer } = await import('../src/server.ts')
  const databasePath = join(workspace, `server-${port}.sqlite`)
  const instance = createWemuxServer({ databasePath, administratorEmails, webStaticPath: webDist, google, googleVerifier })
  // 部署声明的管理员账号先落盘（生产里是「声明邮箱 → 注册 → 验证邮件」），之后的登录与 Google 绑定全走真实路径。
  if (administratorEmails.length > 0) {
    const { seedLocalAccount } = await import('../src/test/fixtures/administrator.ts')
    for (const email of administratorEmails) await seedLocalAccount(instance.store, { username: email, email, password: adminPassword, administrator: true })
  }
  const base = await instance.listen(port, '127.0.0.1')
  return { instance, base, databasePath }
}
const readRows = (databasePath, sql) => {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try { return db.prepare(sql).all().map(row => JSON.parse(String(row.data))) } finally { db.close() }
}
const auditRows = databasePath => readRows(databasePath, "SELECT data FROM records WHERE kind = 'audit'")
const sessionRows = databasePath => readRows(databasePath, 'SELECT data FROM login_sessions')

const browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
const pageErrors = []
if (process.env.WEMUX_DEBUG_URLS) {
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) console.log(`[nav] ${frame.url()}`) })
  page.on('response', response => { const location = response.headers()['location']; if (location) console.log(`[resp ${response.status()}] ${response.url()} -> ${location}`) })
}
page.on('pageerror', error => pageErrors.push(String(error)))
page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) pageErrors.push(`console: ${message.text()}`) })

const shot = async name => {
  const file = join(screenshotDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  results.push(`截图 ${file}`)
}
const googleButton = () => page.getByRole('button', { name: /使用 Google 继续/ })
const bannerText = async () => (await page.locator('[role="alert"]').allInnerTexts()).join(' | ')

const idp = await startFakeGoogle({ clientId, clientSecret })
const authorizeUrls = await routeGoogleAuthorize(page, idp)

const unconfigured = await startServer({ google: {}, port: await freePort() })
const configuredPort = await freePort()
const { createGoogleTokenVerifier } = await import('../src/application/google-oidc.ts')
const configured = await startServer({
  google: { WEMUX_GOOGLE_CLIENT_ID: clientId, WEMUX_GOOGLE_CLIENT_SECRET: clientSecret, WEMUX_PUBLIC_URL: `http://127.0.0.1:${configuredPort}` },
  googleVerifier: createGoogleTokenVerifier({ tokenEndpoint: `${idp.endpoint}/token`, jwksUri: `${idp.endpoint}/jwks` }),
  port: configuredPort,
  administratorEmails: [adminEmail],
})

/** 打开目标地址，点一次 Google 登录，等回调落地（成功进工作台，失败回带 oauth_error 的落地页）。
 * 返回的 callback 是回调响应本身：落地页挂载时会把 oauth_error 从地址栏抹掉，只看 page.url() 会漏判。 */
const signInWithGoogle = async ({ path = '/', identity }) => {
  idp.state.next = identity
  const before = authorizeUrls.length
  await page.goto(`${configured.base}${path}`, { waitUntil: 'networkidle' })
  await googleButton().waitFor({ state: 'visible', timeout: 15000 })
  const pending = page.waitForResponse(response => response.url().includes('/api/auth/oauth/google/callback'), { timeout: 30000 })
  await googleButton().click()
  const callback = new URL((await pending).headers()['location'] ?? '/', configured.base)
  await page.locator('nav, [role="alert"]').first().waitFor({ state: 'visible', timeout: 20000 })
  assert.equal(authorizeUrls.length, before + 1, '每次登录都应发起一次授权跳转')
  return { url: new URL(page.url()), callback, banner: await bannerText() }
}

try {
  // 0. 未配置 Google 的实例：不出现能点但必然失败的入口。
  await page.goto(`${unconfigured.base}/`, { waitUntil: 'networkidle' })
  await page.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await googleButton().count(), 0, '未配置 Google 时不得出现 Google 按钮')
  const options = await (await fetch(`${unconfigured.base}/api/auth/options`)).json()
  assert.equal(options.google.enabled, false)
  results.push(`未配置 Google：/auth/options 报 enabled=false，落地页零 Google 入口（reason: ${options.google.reason}）`)
  await shot('00-unconfigured-no-google-button')

  // 1. 声明邮箱的管理员登录。Google 入口只在登录态出现（注册策略默认只邀请，不能先走 Google 建号），所以先建立账号再验证。
  const fixture = createClient(configured.base)
  const admin = await fixture.signIn({ email: adminEmail, password: adminPassword })
  assert.equal(admin.account.user.email, adminEmail)
  // 新实例默认收紧注册；先显式放开，随后的策略拒绝用例再逐个切回来。
  const opened = await fixture.call('/settings/registration-policy', { method: 'PATCH', csrf: admin.csrf, body: { policy: 'open' } })
  assert.equal(opened.status, 200, `放开注册策略失败：${JSON.stringify(opened.data)}`)
  await page.goto(`${configured.base}/projects`, { waitUntil: 'networkidle' })
  await googleButton().waitFor({ state: 'visible', timeout: 15000 })
  results.push(`声明邮箱的管理员 ${adminEmail} 登录后，登录态落地页出现 Google 入口`)

  // 2. 在 deep link 上点 Google：整页跳授权，回调后回到原地址。
  const landed = await signInWithGoogle({ path: '/projects', identity: { subject: 'google-subject-owner', email: 'google-owner@gmail.com', emailVerified: true, name: 'Google Owner' } })
  assert.equal(landed.callback.search, '', `回调后不应带 oauth_error：${landed.callback.toString()}`)
  assert.equal(landed.url.pathname, '/projects', '登录后应回到发起授权的页面')
  const query = authorizeUrls.at(-1)
  assert.equal(query.response_type, 'code')
  assert.equal(query.code_challenge_method, 'S256')
  assert.equal(query.client_id, clientId)
  assert.equal(query.redirect_uri, `${configured.base}/api/auth/oauth/google/callback`)
  assert.equal(query.scope, 'openid email profile')
  assert.equal('access_type' in query, false, '不得请求 offline access')
  assert.ok(query.state && query.nonce && query.code_challenge)
  const account = await page.evaluate(async () => (await fetch('/api/auth/me')).json())
  assert.equal(account.user.email, 'google-owner@gmail.com')
  assert.equal(account.session.authenticationMethod, 'google')
  assert.equal(account.instanceAdministrator, false, 'Google 首次登录不得顺带获得实例管理员')
  results.push(`授权请求参数正确（code + PKCE S256 + state + nonce，scope=${query.scope}，无 access_type/offline）；回调落在 /projects，邮箱 ${account.user.email}，authenticationMethod=google`)
  await shot('01-google-signed-in')

  // 3. 刷新后仍是同一个会话（Cookie 会话，不靠地址栏里的令牌）。刷新时工作台会保持长连接，按 networkidle 等会超时。
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('nav').first().waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await page.locator('#auth-login').count(), 0, '刷新后不应要求重新登录')
  results.push('刷新后仍是登录态：Cookie 会话不依赖地址栏令牌')

  // 4. 退出后再用同一 Google 身份登录：走绑定路径，不产生第二个账号。
  await page.goto(`${configured.base}/settings`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '退出登录' }).first().click()
  await page.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
  const second = await signInWithGoogle({ identity: { subject: 'google-subject-owner', email: 'google-owner@gmail.com', emailVerified: true, name: 'Google Owner' } })
  assert.equal(second.callback.search, '')
  const oauthAudit = auditRows(configured.databasePath)
  assert.equal(oauthAudit.filter(row => row.action === 'identity.registered').length, 1, '只应注册一次')
  assert.equal(oauthAudit.filter(row => row.action === 'identity.oauth_signed_in').length, 1, '第二次登录应记为已绑定登录')
  assert.equal(idp.state.exchanges, 2, '应发生两次真实的令牌交换')
  results.push('退出后用同一 Google 身份登录：走已绑定登录路径（identity.oauth_signed_in），没有第二个账号')

  // 5. 邮箱权威边界：Gmail/Workspace 之外的邮箱即使 Provider 声明已验证，也不是本站的邮箱证明。
  await page.goto(`${configured.base}/settings`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '退出登录' }).first().click()
  await page.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
  const outsider = await signInWithGoogle({ identity: { subject: 'google-subject-outsider', email: 'google-outsider@yahoo.com', emailVerified: true, name: 'Google Outsider' } })
  assert.equal(outsider.callback.search, '')
  const outsiderAccount = await page.evaluate(async () => (await fetch('/api/auth/me')).json())
  assert.equal(outsiderAccount.user.email, null, '第三方邮箱不得落成本站已验证邮箱')
  assert.equal(outsiderAccount.session.authenticationMethod, 'google', '邮箱不权威不影响本人登录')
  results.push('邮箱权威边界：yahoo 邮箱即使声明已验证也不落成本站邮箱（user.email=null），但本人仍可登录')
  await page.goto(`${configured.base}/settings`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '退出登录' }).first().waitFor({ state: 'visible', timeout: 15000 })
  await shot('02-google-non-authoritative-email')

  // 6. 邮箱冲突：已有账号占着同一个权威邮箱时，必须拒绝且不合并账号。
  await page.goto(`${configured.base}/settings`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '退出登录' }).first().click()
  await page.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
  const conflict = await signInWithGoogle({ identity: { subject: 'google-subject-conflict', email: adminEmail, emailVerified: true, name: 'Google Conflict' } })
  assert.equal(conflict.callback.searchParams.get('oauth_error'), 'email_conflict')
  assert.match(conflict.banner, /已有账号/)
  const conflictAccount = await page.evaluate(async () => { const response = await fetch('/api/auth/me'); return { status: response.status } })
  assert.equal(conflictAccount.status, 401, '冲突时不得签发既有账号的会话')
  assert.match(await bannerText(), /已有账号/)
  // 刷新后地址栏里的错误码必须已被清掉，不能复活旧错误。
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(new URL(page.url()).search, '', '刷新后不得继续带着 oauth_error')
  assert.equal((await bannerText()).includes('已有账号'), false, '刷新后不应重复提示上次的失败')
  results.push('邮箱冲突：拒绝签发会话并提示到原账号显式绑定；地址栏错误码一次性清除')

  // 7. 注册策略：closed 与 invite_only 都必须拒绝陌生人。
  const setPolicy = async policy => {
    const patched = await fixture.call('/settings/registration-policy', { method: 'PATCH', csrf: admin.csrf, body: { policy } })
    assert.equal(patched.status, 200, `切换注册策略失败：${JSON.stringify(patched.data)}`)
  }
  await setPolicy('closed')
  const closed = await signInWithGoogle({ identity: { subject: 'google-subject-closed', email: 'google-closed@gmail.com', emailVerified: true, name: 'Closed' } })
  assert.equal(closed.callback.searchParams.get('oauth_error'), 'registration_closed')
  assert.match(closed.banner, /关闭新账号注册/)
  assert.match(await bannerText(), /关闭新账号注册/)
  await setPolicy('invite_only')
  const invited = await signInWithGoogle({ identity: { subject: 'google-subject-invite', email: 'google-invite@gmail.com', emailVerified: true, name: 'Invite' } })
  assert.equal(invited.callback.searchParams.get('oauth_error'), 'invitation_required')
  assert.match(invited.banner, /仅限邀请/)
  assert.match(await bannerText(), /仅限邀请/)
  await shot('03-oauth-error-banner')
  results.push('策略拒绝：closed → registration_closed，invite_only → invitation_required，提示都不泄漏账号是否存在')

  // 8. 秘密边界与留痕：审计里不得出现 client secret、access token、密码与 state 原文；
  //    失败路径同样留痕，Google 会话必须带 authenticationMethod=google。
  const audit = auditRows(configured.databasePath)
  const serialized = JSON.stringify(audit)
  for (const secret of [clientSecret, 'verify-google-access-token', adminPassword]) {
    assert.equal(serialized.includes(secret), false, `审计里出现了秘密：${secret}`)
  }
  for (const entry of authorizeUrls) assert.equal(serialized.includes(entry.state), false, '审计里出现了 state 原文')
  assert.ok(audit.some(row => row.action === 'identity.oauth_email_conflict'), '邮箱冲突必须留审计')
  assert.ok(audit.some(row => row.action === 'identity.oauth_rejected' && row.metadata.reason === 'registration_closed'))
  assert.ok(audit.some(row => row.action === 'identity.oauth_rejected' && row.metadata.reason === 'invitation_required'))
  const googleSessions = sessionRows(configured.databasePath).filter(row => row.authenticationMethod === 'google')
  assert.ok(googleSessions.length >= 1, 'Google 登录的会话必须标记 authenticationMethod=google')
  assert.ok(sessionRows(configured.databasePath).every(row => String(row.tokenHash).length === 64), '会话令牌只能存哈希')
  results.push(`留痕与屏蔽：冲突/策略拒绝各有审计条目，秘密与 state 原文零出现；Google 会话 ${googleSessions.length} 条标记 authenticationMethod=google`)

  assert.deepEqual(pageErrors, [], `页面出现脚本错误：${pageErrors.join(' | ')}`)
  const report = { base: configured.base, databasePath: configured.databasePath, authorizationRequests: authorizeUrls, tokenExchanges: idp.state.exchanges, results, pageErrors }
  await writeFile(join(workspace, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\nGoogle 登录真实浏览器验收通过（Server ${configured.base}，证据 ${workspace}）`)
  for (const line of results) console.log(`- ${line}`)
} finally {
  await context.close(); await browser.close()
  await configured.instance.close(); await unconfigured.instance.close()
  idp.server.close()
  if (process.env.WEMUX_KEEP_SHOTS) console.log(`截图保留在 ${screenshotDir}`)
  else await rm(workspace, { recursive: true, force: true })
}