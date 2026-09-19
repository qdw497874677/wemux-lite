// Wave A / Wave B 跨票据验收：单实例上依次跑完 Ticket 04（管理员认领与会话）、05（邮箱注册与验证）、
// 07（Google 注册与登录）、17（会话血缘授权），断言这些切片之间的**交互**——单票据脚本各测各的，
// 只有串起来才能发现「策略只对新账号生效」「自助账号不得读别人的血缘」「邮件链接回到 SPA」这类跨切片回归。
// 真实浏览器 + 真实 Server 进程内实例（同一套生产代码）；Google 只替换授权页与令牌端点，见 `lib/fake-google.mjs`。
//   WEMUX_KEEP_SHOTS=1 node --import tsx apps/server/scripts/verify-wave-ab.mjs
// 可覆盖：WEMUX_PLAYWRIGHT（playwright-core 入口）、WEMUX_CHROME（Chromium 可执行文件）、WEMUX_KEEP_SHOTS=1（保留截图与证据）。
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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

const clientId = 'verify-wave-client-id.apps.googleusercontent.com'
const clientSecret = 'verify-wave-client-secret'
const adminEmail = 'wave-admin@gmail.com'
const adminPassword = 'wave-admin-password-value'
const memberEmail = 'wave-member@gmail.com'
const memberName = 'Wave Member'
const memberPassword = 'wave-member-password-value'
const googleEmail = 'wave-google@gmail.com'
const googleSubject = 'wave-google-subject'

if (!existsSync(join(webDist, 'index.html'))) throw new Error(`缺少 Web 构建产物：${webDist}。先运行 npm run build:web。`)
const { chromium } = await import(playwrightEntry)

const workspace = await mkdtemp(join(tmpdir(), 'wemux-wave-ab-'))
const screenshotDir = process.env.WEMUX_KEEP_SHOTS ? join(workspace, 'screenshots') : workspace
await mkdir(screenshotDir, { recursive: true })
const outbox = join(workspace, 'outbox')
const results = []
const pageErrors = []

const freePort = async () => {
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}

/** 脚本内的最小 HTTP 客户端：Cookie 罐 + CSRF，用来准备实例状态并做「非浏览器」的授权探针。 */
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
    return { status: response.status, data, headers: response.headers }
  }
  return {
    call,
    signIn: async (login, password) => {
      const signedIn = await call('/auth/login', { body: { login, password } })
      assert.equal(signedIn.status, 200, `登录失败：${JSON.stringify(signedIn.data)}`)
      // CSRF 明文从 `/auth/me` 拿：登录响应只给会话 Cookie，令牌单独轮换下发。
      const me = await call('/auth/me')
      return me.data?.csrfToken
    },
  }
}

const readRows = (databasePath, sql) => {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try { return db.prepare(sql).all().map(row => JSON.parse(String(row.data))) } finally { db.close() }
}
const auditRows = databasePath => readRows(databasePath, "SELECT data FROM records WHERE kind = 'audit'")
const challengeRows = databasePath => {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try { return db.prepare('SELECT purpose, token_hash, target_email, consumed_at FROM verification_challenges').all() } finally { db.close() }
}
const identityRows = databasePath => {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try { return db.prepare('SELECT provider, issuer, subject, user_id FROM login_identities').all() } finally { db.close() }
}
const userRows = databasePath => {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try { return db.prepare('SELECT id, data FROM records WHERE kind = \'user\'').all().map(row => JSON.parse(String(row.data))) } finally { db.close() }
}

/** 本地出件箱：邮件正文是 base64 折行的 MIME 体，取链接的方式与 Ticket 05 脚本一致。 */
const outboxBodies = async () => {
  const names = (await readdir(outbox)).filter(name => name.endsWith('.eml'))
  const entries = await Promise.all(names.map(async name => ({ name, written: (await stat(join(outbox, name))).mtimeMs })))
  entries.sort((a, b) => a.written - b.written || a.name.localeCompare(b.name))
  return Promise.all(entries.map(async entry => {
    const raw = await readFile(join(outbox, entry.name), 'utf8')
    return Buffer.from(raw.slice(raw.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString('utf8')
  }))
}
const linkFor = async (base, path) => {
  for (const text of [...await outboxBodies()].reverse()) {
    const match = new RegExp(`(${base.replace(/[/:.]/g, '\\$&')}${path.replace('/', '\\/')}\\?token=[A-Za-z0-9_-]+)`).exec(text)
    if (match) return match[1]
  }
  throw new Error(`出件箱里没有 ${path} 链接`)
}

const idp = await startFakeGoogle({ clientId, clientSecret })
const browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ['--no-sandbox'] })

/** 每个身份一个独立 BrowserContext：Cookie 罐互不相通，才能真正证明会话隔离。 */
const newIdentityPage = async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(String(error)))
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) pageErrors.push(`console: ${message.text()}`) })
  const authorizeUrls = await routeGoogleAuthorize(page, idp)
  return { context, page, authorizeUrls }
}
const shot = async (page, name) => {
  const file = join(screenshotDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  results.push(`截图 ${file}`)
}
const accountOf = async page => page.evaluate(async () => (await fetch('/api/auth/me')).json())
const logout = async page => {
  await page.goto(base + '/settings', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '退出登录' }).first().click()
  await page.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
}

const startServer = async () => {
  const { createWemuxServer } = await import('../src/server.ts')
  const { createGoogleTokenVerifier } = await import('../src/application/google-oidc.ts')
  const port = await freePort()
  const databasePath = join(workspace, 'server.sqlite')
  const base = `http://127.0.0.1:${port}`
  const instance = createWemuxServer({
    databasePath,
    administratorEmails: [adminEmail],
    webStaticPath: webDist,
    mail: { WEMUX_MAIL_OUTBOX: outbox, WEMUX_SMTP_FROM: 'Wemux Lite <no-reply@wemux.test>', WEMUX_PUBLIC_URL: base },
    google: { WEMUX_GOOGLE_CLIENT_ID: clientId, WEMUX_GOOGLE_CLIENT_SECRET: clientSecret, WEMUX_PUBLIC_URL: base },
    googleVerifier: createGoogleTokenVerifier({ tokenEndpoint: `${idp.endpoint}/token`, jwksUri: `${idp.endpoint}/jwks` }),
  })
  await instance.listen(port, '127.0.0.1')
  // 部署声明的管理员账号先落盘（生产里是「声明邮箱 → 注册 → 验证邮件」），之后的登录与身份绑定全走真实路径。
  const { seedLocalAccount } = await import('../src/test/fixtures/administrator.ts')
  await seedLocalAccount(instance.store, { username: adminEmail, email: adminEmail, password: adminPassword, administrator: true })
  return { instance, base, databasePath }
}

const { instance, base, databasePath } = await startServer()
const adminClient = createClient(base)

/** 点一次 Google 登录：返回回调地址（错误码在这里）与页面提示。 */
const signInWithGoogle = async ({ page, authorizeUrls, identity }) => {
  idp.state.next = identity
  const before = authorizeUrls.length
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
  const button = page.getByRole('button', { name: /使用 Google 继续/ })
  await button.waitFor({ state: 'visible', timeout: 15000 })
  const callback = page.waitForResponse(response => response.url().includes('/api/auth/oauth/google/callback'), { timeout: 30000 })
  await button.click()
  const location = new URL((await callback).headers()['location'] ?? '/', base)
  await page.locator('nav, [role="alert"]').first().waitFor({ state: 'visible', timeout: 20000 })
  assert.equal(authorizeUrls.length, before + 1, '每次登录都应发起一次授权跳转')
  const banners = await page.locator('[role="alert"]').allInnerTexts()
  return { callback: location, banners: banners.join(' | '), account: await accountOf(page) }
}

try {
  // 1. 部署声明的管理员登录（Ticket 04）并开放自助注册（Ticket 05）：后续所有身份都建立在这两条之上。
  // CSRF 明文是一次性轮换：`/auth/me` 每轮换一次就作废上一个，所以只拿最后一次的令牌去做写操作。
  await adminClient.signIn(adminEmail, adminPassword)
  const adminAccount = await adminClient.call('/auth/me')
  const adminCsrf = adminAccount.data.csrfToken
  assert.equal(adminAccount.data.instanceAdministrator, true, '部署声明的管理员必须是实例管理员')
  const opened = await adminClient.call('/settings/registration-policy', { method: 'PATCH', csrf: adminCsrf, body: { policy: 'open' } })
  assert.equal(opened.status, 200, `开放注册失败：${JSON.stringify(opened.data)}`)
  results.push(`部署声明的管理员 ${adminEmail} 登录（instanceAdministrator=true），并把注册策略显式改为开放`)

  // 2. 邮箱注册 + 激活（Ticket 05）：新账号不得顺带获得实例权限，且只能读自己。
  const member = await newIdentityPage()
  await member.page.goto(base + '/', { waitUntil: 'domcontentloaded' })
  // 登录入口必须跟实例状态一致。先等一个依赖 `/auth/options` 的元素出现，
  // 否则“找不到旧认领入口”只是因为选项还没到，断言会变成空真。
  await member.page.getByRole('button', { name: '忘记密码？' }).waitFor({ state: 'visible', timeout: 15000 })
  await member.page.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await member.page.locator('#auth-bootstrap').count(), 0, '实例不再有任何引导令牌字段')
  await member.page.getByRole('button', { name: '还没有账号？用邮箱注册' }).click()
  await member.page.locator('#auth-email').fill(memberEmail)
  await member.page.locator('#auth-display').fill(memberName)
  await member.page.locator('#auth-password').fill(memberPassword)
  await member.page.locator('#auth-confirm').fill(memberPassword)
  await member.page.getByRole('button', { name: '发送验证邮件' }).click()
  await member.page.getByText('验证邮件已发送').waitFor({ state: 'visible', timeout: 15000 })
  const verifyUrl = await linkFor(base, '/auth/verify-email')
  await member.page.goto(verifyUrl, { waitUntil: 'domcontentloaded' })
  await member.page.getByRole('button', { name: '确认并激活账号' }).click()
  await member.page.locator('nav').first().waitFor({ state: 'visible', timeout: 15000 })
  const memberAccount = await accountOf(member.page)
  assert.equal(memberAccount.user.email, memberEmail)
  assert.equal(memberAccount.instanceAdministrator, false, '自助注册账号不得成为实例管理员')
  assert.equal(memberAccount.session.authenticationMethod, 'password', '邮箱注册的会话来源必须是 password')
  results.push(`邮箱注册并激活 ${memberEmail}：authenticationMethod=password，非实例管理员`)

  // 3. Google 首次登录（Ticket 07）建立第二个身份：与邮箱账号并存，互不覆盖。
  const google = await newIdentityPage()
  const firstGoogle = await signInWithGoogle({ page: google.page, authorizeUrls: google.authorizeUrls, identity: { subject: googleSubject, email: googleEmail, emailVerified: true, name: 'Wave Google' } })
  assert.equal(firstGoogle.callback.search, '', `Google 首次登录不应带 oauth_error：${firstGoogle.callback.toString()}`)
  assert.equal(firstGoogle.account.user.email, googleEmail)
  assert.equal(firstGoogle.account.session.authenticationMethod, 'google')
  assert.equal(firstGoogle.account.instanceAdministrator, false, 'Google 首次登录不得获得实例管理员')
  assert.equal(google.authorizeUrls.at(-1).code_challenge_method, 'S256', '授权请求必须带 PKCE S256')
  results.push(`Google 首次登录 ${googleEmail}：authenticationMethod=google，PKCE S256，非实例管理员`)

  // 4. 跨切片：邮箱账号占着同一个权威邮箱时，Google 登录必须拒绝并指向显式绑定（05 × 07）。
  await logout(member.page)
  const conflict = await signInWithGoogle({ page: member.page, authorizeUrls: member.authorizeUrls, identity: { subject: 'wave-google-conflict', email: memberEmail, emailVerified: true, name: 'Wave Conflict' } })
  assert.equal(conflict.callback.searchParams.get('oauth_error'), 'email_conflict', `同邮箱 Google 登录必须报 email_conflict：${conflict.callback.toString()}`)
  assert.match(conflict.banners, /已有账号/, '必须给出显式绑定的指引，而不是静默失败')
  assert.match(conflict.banners, /绑定/, '提示要说明去账号安全设置绑定 Google')
  assert.equal(conflict.account.user === undefined, true, '冲突时不得签发任何会话')
  // 用独立 Cookie 罐验证原账号密码仍可登录：不能污染 adminClient 的管理员会话。
  const memberPasswordClient = createClient(base)
  assert.ok(await memberPasswordClient.signIn(memberEmail, memberPassword), '冲突不得破坏原账号的密码登录')
  await memberPasswordClient.call('/auth/logout', { method: 'POST' })
  const memberUsers = userRows(databasePath).filter(user => user.email === memberEmail)
  assert.equal(memberUsers.length, 1, `同邮箱冲突不得产生第二个账号，实际 ${memberUsers.length}`)
  await shot(member.page, '01-email-conflict-binding-guidance')
  results.push('同邮箱 Google 登录：拒绝签发会话 + 显式绑定指引，原账号数量与密码登录不受影响（05 × 07）')

  // 4b. 跨切片：权威边界反过来也要拿得住——第三方邮箱不算本站邮箱证明，不得与同地址的密码账号合并（05 × 07）。
  const outsider = await newIdentityPage()
  const claimed = await signInWithGoogle({ page: outsider.page, authorizeUrls: outsider.authorizeUrls, identity: { subject: 'wave-google-outsider', email: memberName + '@example.com', emailVerified: true, name: 'Wave Outsider' } })
  assert.equal(claimed.callback.search, '', `第三方邮箱登录本人应成功：${claimed.callback.toString()}`)
  assert.equal(claimed.account.user.email, null, '第三方邮箱不得落成本站已验证邮箱（即使 Provider 声明已验证）')
  assert.notEqual(claimed.account.user.id, memberAccount.user.id, '第三方邮箱不得并入同地址的密码账号')
  await outsider.context.close()
  results.push('权威边界：example.com 即使声明已验证也不落成本站邮箱，不会并入同地址的密码账号（05 × 07）')

  // 5. 跨切片：注册策略只挡“新账号”，不能把已绑定的 Google 老账号一起锁在门外（05 × 07）。
  const closed = await adminClient.call('/settings/registration-policy', { method: 'PATCH', csrf: adminCsrf, body: { policy: 'closed' } })
  assert.equal(closed.status, 200, `关闭注册失败：${JSON.stringify(closed.data)}`)
  const unknownWhileClosed = await signInWithGoogle({ page: member.page, authorizeUrls: member.authorizeUrls, identity: { subject: 'wave-google-stranger', email: 'wave-stranger@gmail.com', emailVerified: true, name: 'Wave Stranger' } })
  assert.equal(unknownWhileClosed.callback.searchParams.get('oauth_error'), 'registration_closed', '关闭注册后陌生人不得创建账号')
  await logout(google.page)
  const returning = await signInWithGoogle({ page: google.page, authorizeUrls: google.authorizeUrls, identity: { subject: googleSubject, email: googleEmail, emailVerified: true, name: 'Wave Google' } })
  assert.equal(returning.callback.search, '', `关闭注册不得影响已绑定账号登录：${returning.callback.toString()}`)
  assert.equal(returning.account.user.email, googleEmail, '已绑定账号必须仍能登录')
  const reopened = await adminClient.call('/settings/registration-policy', { method: 'PATCH', csrf: adminCsrf, body: { policy: 'open' } })
  assert.equal(reopened.status, 200)
  results.push('注册策略只限制新账号：closed 下陌生人 registration_closed，已绑定 Google 账号照常登录（05 × 07）')

  // 6. 跨切片：三种来源的会话互不干扰；退出登录只撤销自己的那一个（04 × 05 × 07）。
  const adminBrowser = await newIdentityPage()
  await adminBrowser.page.goto(base + '/', { waitUntil: 'domcontentloaded' })
  await adminBrowser.page.locator('#auth-login').fill(adminEmail)
  await adminBrowser.page.locator('#auth-password').fill(adminPassword)
  await adminBrowser.page.getByRole('button', { name: '登录' }).click()
  await adminBrowser.page.locator('nav').first().waitFor({ state: 'visible', timeout: 15000 })
  await member.page.goto(base + '/', { waitUntil: 'domcontentloaded' })
  await member.page.locator('#auth-login').fill(memberEmail)
  await member.page.locator('#auth-password').fill(memberPassword)
  await member.page.getByRole('button', { name: '登录' }).click()
  await member.page.locator('nav').first().waitFor({ state: 'visible', timeout: 15000 })
  const three = await Promise.all([adminBrowser.page, member.page, google.page].map(accountOf))
  assert.deepEqual(three.map(account => account.session.authenticationMethod), ['password', 'password', 'google'], '三个会话应来自三种身份来源')
  assert.equal(new Set(three.map(account => account.user.id)).size, 3, '三个会话必须属于三个不同账号')
  const memberCookies = await member.context.cookies()
  const sessionCookies = memberCookies.filter(cookie => /session/i.test(cookie.name))
  assert.ok(sessionCookies.length >= 1, '登录后必须存在会话 Cookie')
  for (const cookie of sessionCookies) {
    assert.equal(cookie.httpOnly, true, `会话 Cookie 必须 HttpOnly：${cookie.name}`)
    assert.equal(cookie.sameSite, 'Lax', `会话 Cookie 必须 SameSite=Lax：${cookie.name}`)
  }
  const storage = await member.page.evaluate(() => ({ cookie: document.cookie, local: { ...localStorage }, session: { ...sessionStorage } }))
  assert.equal(/session|token/i.test(storage.cookie), false, `脚本不得读到会话 Cookie：${storage.cookie}`)
  const entries = [...Object.entries(storage.local), ...Object.entries(storage.session)]
  // 唯一允许的本地键是设备标识（`wemux.device`）；Ticket 04 之前的长期凭据键必须已被明确退役。
  assert.equal(Object.keys(storage.local).includes('wemux.connection'), false, '旧版本的长期凭据键必须已被清除')
  for (const [key, value] of entries) {
    assert.equal(/token|credential|secret|csrf/i.test(key), false, `Web Storage 不得存放凭据键：${key}`)
    if (key === 'wemux.device') continue
    assert.equal(/^[A-Za-z0-9_-]{32,}$/.test(value), false, `Web Storage 里出现类似令牌的值：${key}`)
  }
  results.push(`Web Storage 只留设备标识：无旧凭据键；会话 Cookie HttpOnly=${sessionCookies.map(cookie => cookie.httpOnly).join(',')}`)
  await logout(member.page)
  const afterMemberLogout = await Promise.all([adminBrowser.page, google.page].map(accountOf))
  assert.ok(afterMemberLogout.every(account => account.user?.id), '一个身份退出登录不得影响其他身份')
  assert.equal((await member.page.evaluate(async () => (await fetch('/api/auth/me')).status)), 401, '退出后自己的会话必须失效')
  await shot(member.page, '02-session-isolation')
  results.push('会话隔离：三个身份并存且互不影响；退出只撤销自己；Cookie HttpOnly + SameSite=Lax（04 × 05 × 07）')

  // 7. 跨切片：血缘与 Fork 的授权边界——自助账号不得通过血缘入口读别人的会话（05 × 17）。
  const created = await adminClient.call('/projects', { method: 'POST', csrf: adminCsrf, body: { name: 'wave-ab-project' } })
  assert.equal(created.status, 201, `创建项目失败：${JSON.stringify(created.data)}`)
  const projectId = created.data.id ?? created.data.project?.id
  assert.ok(projectId, '项目 id 必须可读')
  const adminGraph = await adminClient.call(`/projects/${projectId}/session-graph`)
  assert.equal(adminGraph.status, 200, `管理员必须能读血缘图：${JSON.stringify(adminGraph.data)}`)
  assert.ok(adminGraph.data.graph, '管理员响应必须带 graph')
  const memberClient = createClient(base)
  const memberCsrf = await memberClient.signIn(memberEmail, memberPassword)
  const memberGraph = await memberClient.call(`/projects/${projectId}/session-graph`)
  const memberFork = await memberClient.call(`/projects/${projectId}/session-forks`, { method: 'POST', csrf: memberCsrf, body: { sourceSessionId: 'session-probe', targetWorkspaceId: 'workspace-probe', targetWorkerId: 'worker-probe', targetAgentKey: 'pi', requestId: randomUUID() } })
  const anonymousGraph = await fetch(`${base}/api/projects/${projectId}/session-graph`)
  assert.equal(anonymousGraph.status, 401, `未登录读血缘图必须 401，实际 ${anonymousGraph.status}`)
  // 本波锁定的是「不泄露 + 管理面健康」：成员进入控制面要等 Ticket 10/12 开放，现在整块控制面统一 403 admin_required。
  for (const [label, response] of [['读图', memberGraph], ['建 Fork', memberFork]]) {
    assert.equal(response.status, 403, `非管理员${label}必须 403，实际 ${response.status}：${JSON.stringify(response.data)}`)
    assert.equal(response.data?.error?.code, 'admin_required', `${label}拒绝理由必须是 admin_required`)
  }
  const leaked = ['graph', 'forks', 'fork', 'sessions', 'lineage', 'entries']
  for (const [label, response] of [['读图', memberGraph], ['建 Fork', memberFork]]) {
    assert.deepEqual(Object.keys(response.data ?? {}).filter(key => leaked.includes(key)), [], `${label}拒绝响应不得夹带血缘数据：${JSON.stringify(response.data)}`)
  }
  // 同一条路由用管理员跑一次：证明成员的 403 是授权而非路由不存在（否则“拒绝”可能只是坏接口）。
  const adminForkProbe = await adminClient.call(`/projects/${projectId}/session-forks`, { method: 'POST', csrf: adminCsrf, body: { sourceSessionId: 'session-probe', targetWorkspaceId: 'workspace-probe', targetWorkerId: 'worker-probe', targetAgentKey: 'pi', requestId: randomUUID() } })
  assert.equal(adminForkProbe.status, 404, `管理员跑同一 Fork 路由应得到业务层 404（源会话不存在），实际 ${adminForkProbe.status}：${JSON.stringify(adminForkProbe.data)}`)
  results.push(`血缘路由健康但不向非管理员开放：管理员读图 200 且带 graph、Fork 探针 404（业务层）；成员读图/建 Fork 均 403 admin_required 且无数据泄露；匿名 401（05 × 17）`)

  // 8. 跨切片：实例级配置面只对管理员开放，账号自助面仍对所有人开放（04 × 05）。
  const memberPolicyRead = await memberClient.call('/settings/registration-policy')
  assert.equal(memberPolicyRead.status, 403, `非管理员不得读实例配置：${JSON.stringify(memberPolicyRead.data)}`)
  assert.equal(memberPolicyRead.data?.error?.code, 'admin_required', '拒绝理由必须是 admin_required')
  const memberPolicyWrite = await memberClient.call('/settings/registration-policy', { method: 'PATCH', csrf: memberCsrf, body: { policy: 'open' } })
  assert.equal(memberPolicyWrite.status, 403, `非管理员不得改实例配置：${JSON.stringify(memberPolicyWrite.data)}`)
  const memberSelfSessions = await memberClient.call('/auth/sessions')
  assert.equal(memberSelfSessions.status, 200, '账号自助面（自己的会话列表）必须可用')
  results.push('权限面分离：实例配置 403 admin_required（读与写都拒），账号自助面 200（04 × 05）')

  // 9. 邮件链接回到 SPA（今天修的回归在整条流程里的锁）：确认页与重置页都必须是页面而非 401 JSON。
  for (const path of ['/auth/verify-email?token=probe-token-value', '/auth/password/reset?token=probe-token-value']) {
    const pageResponse = await fetch(`${base}${path}`, { headers: { accept: 'text/html,application/xhtml+xml' } })
    assert.equal(pageResponse.status, 200, `${path} 必须返回页面`)
    assert.match(pageResponse.headers.get('content-type') ?? '', /text\/html/, `${path} 必须是 text/html`)
    assert.equal((await pageResponse.text()).includes('wemux'), true, `${path} 必须渲染 Web 控制台`)
  }
  const apiNamespace = await fetch(`${base}/api/auth/verify-email?token=probe-token-value`, { headers: { accept: 'text/html' } })
  assert.equal(apiNamespace.headers.get('content-type')?.includes('text/html'), false, '/api/auth/* 不得被 SPA 回退截走')
  results.push('邮件链接路由：/auth/verify-email 与 /auth/password/reset 返回页面，/api/auth/* 仍是 API')

  // 10. 秘密与留痕：一次性令牌只存哈希；邮箱验证挑战已消费，重置挑战待用（05）。
  const resetRequested = await adminClient.call('/auth/password/forgot', { body: { email: memberEmail } })
  assert.equal(resetRequested.status, 202, `申请密码重置失败：${JSON.stringify(resetRequested.data)}`)
  const resetUrl = await linkFor(base, '/auth/password/reset')
  const challenges = challengeRows(databasePath)
  const purposes = [...new Set(challenges.map(row => row.purpose))].sort()
  assert.deepEqual(purposes, ['reset_password', 'verify_email'], `两类挑战都应落库，实际 ${purposes.join(',')}`)
  assert.ok(challenges.every(row => row.token_hash.length === 64), '挑战令牌只能存哈希（64 字符）')
  assert.equal(challenges.filter(row => row.purpose === 'verify_email' && row.consumed_at !== null).length, 1, '邮箱验证挑战必须已被消费')
  assert.equal(challenges.filter(row => row.purpose === 'reset_password' && row.consumed_at === null).length, 1, '待用的重置挑战不得被标记为已消费')
  const rawTokens = [new URL(verifyUrl).searchParams.get('token'), new URL(resetUrl).searchParams.get('token')]
  assert.ok(rawTokens.every(Boolean), '验证与重置链接都必须带 token')
  const databaseBytes = await readFile(databasePath, 'latin1')
  for (const rawToken of rawTokens) assert.equal(databaseBytes.includes(rawToken), false, '数据库文件里不得出现一次性令牌原文')
  const identities = identityRows(databasePath)
  assert.equal(identities.length, 2, `被拒的登录不得留下身份绑定（只应有已绑定与第三方邮箱两条），实际 ${identities.length}`)
  assert.ok(identities.every(row => row.provider === 'google'), '身份绑定只能是 google provider')
  assert.ok(identities.some(row => row.subject === googleSubject), '已绑定的 Google 身份必须在场')
  const audit = auditRows(databasePath)
  const serialized = JSON.stringify(audit)
  for (const secret of [clientSecret, adminPassword, memberPassword]) assert.equal(serialized.includes(secret), false, `审计里出现了秘密：${secret}`)
  assert.equal(serialized.includes(rawTokens[0]), false, '审计里不得出现一次性令牌原文')
  const conflicts = audit.filter(row => row.action === 'identity.oauth_email_conflict')
  assert.equal(conflicts.length, 1, `权威邮箱冲突必须留审计且只有一次，实际 ${conflicts.length}`)
  const masked = conflicts[0].metadata?.email
  assert.match(String(masked), /\*\*\*@/, `冲突审计里的邮箱必须是掩码形式：${masked}`)
  assert.equal(serialized.includes(memberEmail), false, '审计里不得出现邮箱原文')
  results.push(`秘密边界：令牌只存哈希且用后消费，数据库与审计里零原文；被拒登录不留绑定；冲突留痕 ${conflicts.length} 次（邮箱已掩码）`)

  assert.deepEqual(pageErrors, [], `页面出现脚本错误：${pageErrors.join(' | ')}`)
  const report = { base, databasePath, outbox, results, pageErrors, tokenExchanges: idp.state.exchanges }
  await writeFile(join(workspace, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\nWave A/B 跨票据验收通过（Server ${base}，证据 ${workspace}）`)
  for (const line of results) console.log(`- ${line}`)
} finally {
  await browser.close().catch(() => {})
  await instance.close().catch(() => {})
  idp.server.close()
  if (process.env.WEMUX_KEEP_SHOTS) console.log(`\n证据保留在 ${workspace}`)
  else await rm(workspace, { recursive: true, force: true }).catch(() => {})
}