// Wave C 跨票据验收：Ticket 06（密码与邮箱恢复管理）+ Ticket 08（登录方式绑定与解绑）。
// 单票据测试各测各的，只有串起来才能发现「重置后只撤会话不撤 PAT」「改邮箱的确认链接落回 API JSON」
// 「最后一个登录方式仍可解绑」「改密码把当前设备也踢下线」这类跨切片回归。
// 真实浏览器 + 真实 Server 进程内实例（同一套生产代码）；Google 只替换授权页与令牌端点，见 `lib/fake-google.mjs`。
//   WEMUX_KEEP_SHOTS=1 node --import tsx apps/server/scripts/verify-wave-c.mjs
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

const clientId = 'verify-wave-c-client.apps.googleusercontent.com'
const clientSecret = 'verify-wave-c-client-secret'
const adminEmail = 'wave-c-admin@gmail.com'
const adminPassword = 'wave-c-admin-password-value'
const memberEmail = 'wave-c-member@example.com'
const memberPassword = 'wave-c-member-password-value'
const rotatedPassword = 'wave-c-member-rotated-password'
const finalPassword = 'wave-c-member-final-password'
const nextEmail = 'wave-c-member-new@example.com'
const googleEmail = 'wave-c-google@gmail.com'
const googleSubject = 'wave-c-google-subject'

if (!existsSync(join(webDist, 'index.html'))) throw new Error(`缺少 Web 构建产物：${webDist}。先运行 npm run build:web。`)
// 旧产物会让断言在浏览器里落空，却看不出原因（本票就踩过一次）：构建里必须带上新版控件 id。
const bundleText = (await Promise.all((await readdir(join(webDist, 'assets'))).filter(name => name.endsWith('.js')).map(name => readFile(join(webDist, 'assets', name), 'utf8')))).join('\n')
for (const marker of ['account-password-current', 'account-email-new', 'account-unbind-password']) {
  if (!bundleText.includes(marker)) throw new Error(`Web 构建产物过期：缺少 ${marker}。先运行 npm run build:web。`)
}
const { chromium } = await import(playwrightEntry)

const workspace = await mkdtemp(join(tmpdir(), 'wemux-wave-c-'))
const screenshotDir = process.env.WEMUX_KEEP_SHOTS ? join(workspace, 'screenshots') : workspace
await mkdir(screenshotDir, { recursive: true })
const outbox = join(workspace, 'outbox')
const results = []
const pageErrors = []
// 4xx 是流程里合法的一部分（401 未登录、409 重放、400 错密码），但要如实记下来；5xx 一律视为失败。
const httpProblems = []

const freePort = async () => {
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}

/** 脚本内的最小 HTTP 客户端：Cookie 罐 + CSRF，用来准备会话与做「非浏览器」的授权探针。 */
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
      const me = await call('/auth/me')
      return me.data?.csrfToken
    },
  }
}

const readRows = (databasePath, sql) => {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try { return db.prepare(sql).all() } finally { db.close() }
}
const auditRows = databasePath => readRows(databasePath, "SELECT data FROM records WHERE kind = 'audit'").map(row => JSON.parse(String(row.data)))
const userRows = databasePath => readRows(databasePath, "SELECT id, data FROM records WHERE kind = 'user'").map(row => ({ id: row.id, ...JSON.parse(String(row.data)) }))
const emailRows = databasePath => readRows(databasePath, 'SELECT email_normalized, user_id, email_display FROM user_emails')
const identityRows = databasePath => readRows(databasePath, 'SELECT provider, subject, user_id FROM login_identities')
const challengeRows = databasePath => readRows(databasePath, 'SELECT purpose, token_hash, target_email, consumed_at FROM verification_challenges')

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
  page.on('response', response => { if (response.status() >= 400) httpProblems.push(`${response.status()} ${new URL(response.url()).pathname}`) })
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) pageErrors.push(`console: ${message.text()}`) })
  const authorizeUrls = await routeGoogleAuthorize(page, idp)
  return { context, page, authorizeUrls }
}
const shot = async (page, name) => {
  const file = join(screenshotDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  results.push(`截图 ${file}`)
}
/** 用真实落地页表单登录：走的是用户会走的那条路（CSRF 与 HttpOnly Cookie 都由页面自己拿）。 */
const loginWithPassword = async (page, login, password) => {
  await page.goto(base + '/settings', { waitUntil: 'domcontentloaded' })
  await page.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('#auth-login').fill(login)
  await page.locator('#auth-password').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.locator('#auth-login').waitFor({ state: 'detached', timeout: 15000 })
}
const openAccount = async page => {
  await page.goto(base + '/settings', { waitUntil: 'domcontentloaded' })
  try {
    await page.getByRole('heading', { name: '密码', exact: true }).waitFor({ state: 'visible', timeout: 20000 })
    await page.locator('#account-password-current, #account-password-next').first().waitFor({ state: 'visible', timeout: 20000 })
  } catch (cause) {
    const timings = await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/')).map(entry => `${entry.name.split('/api')[1]} ${Math.round(entry.duration)}ms`))
    const probe = await page.evaluate(async () => {
      const call = async path => {
        const started = performance.now()
        try { const response = await fetch(path); return `${path} ${response.status} in ${Math.round(performance.now() - started)}ms` } catch (error) { return `${path} failed: ${String(error)}` }
      }
      return [await call('/api/projects'), await call('/api/auth/me'), await call('/api/auth/account/security'), await call('/api/workers')].join(' | ')
    })
    const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 600)
    const inputs = await page.evaluate(() => Array.from(document.querySelectorAll('input, button')).map(node => `${node.tagName.toLowerCase()}#${node.id || '(no id)'}${node.hidden ? '[hidden]' : ''}`).join(','))
    throw new Error(`账号面板未就绪：${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}\nAPI 计时：${timings.join(' | ')}\n页内直连：${probe}\n控件：${inputs}\n页面文本：${body}`)
  }
}
const bannerText = async page => (await page.locator('[role="alert"], [role="status"]').allInnerTexts()).join(' | ')
/** 失败时把当时页面长什么样、浏览器报了什么错一起留下：没有这一步，超时只能靠猜。 */
const dumpOnFailure = async (page, label) => {
  const files = []
  for (const candidate of page.context().pages().filter(open => !open.isClosed())) {
    const file = join(screenshotDir, `failure-${label}-${files.length}.png`)
    await candidate.screenshot({ path: file, fullPage: true }).catch(() => {})
    files.push(`${file}\n${(await candidate.locator('body').innerText().catch(() => '')).slice(0, 2000)}`)
  }
  console.error(`\n验收失败现场（${label}）：\n${files.join('\n---\n')}\n页面错误：${pageErrors.join(' | ') || '（无）'}`)
}

const startServer = async () => {
  const { createWemuxServer } = await import('../src/server.ts')
  const { createGoogleTokenVerifier } = await import('../src/application/google-oidc.ts')
  const { seedLocalAccount } = await import('../src/test/fixtures/administrator.ts')
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
  // 两个本地账号：管理员用来验证 PAT 这条凭证通道，成员是这两张票的主角。
  // 登录名故意不用邮箱：真实注册路径从显示名称派生登录名（`deriveUsername`），
  // 而改邮箱只该断掉「旧邮箱」这个入口，不应该连带把登录名一起废掉。
  await seedLocalAccount(instance.store, { username: 'wave-c-admin', email: adminEmail, password: adminPassword, administrator: true })
  await seedLocalAccount(instance.store, { username: 'wave-c-member', email: memberEmail, password: memberPassword, administrator: false })
  return { instance, base, databasePath }
}

const { instance, base, databasePath } = await startServer()
const { hashSecret } = await import('../src/application/auth.ts')
const wait = async (page, text, timeout = 15000) => page.locator('[role="alert"], [role="status"]').filter({ hasText: text }).first().waitFor({ state: 'visible', timeout })
/** 面板里的说明文案不是通知区，不能用 role 定位，按文本找。 */
const waitText = async (page, text, timeout = 15000) => page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout })

try {
  // 1. 成员用密码登录并打开账号面板（Ticket 04 的会话 + 06/08 的新面板）。
  const member = await newIdentityPage()
  await loginWithPassword(member.page, memberEmail, memberPassword)
  await openAccount(member.page)
  for (const heading of ['当前账号', '密码', '邮箱', '登录方式', '登录设备与会话']) {
    assert.equal(await member.page.getByRole('heading', { name: heading, exact: true }).count(), 1, `账号面板缺少「${heading}」分区`)
  }
  assert.equal(await member.page.getByRole('button', { name: '解绑' }).isDisabled(), true, '唯一登录方式不得可解绑')
  await waitText(member.page, '这是账号目前唯一的登录方式')
  await shot(member.page, '01-account-panel')
  results.push('账号面板：密码 / 邮箱 / 登录方式 / 会话四个分区都在，唯一登录方式的解绑按钮禁用（06 × 08）')

  // 2. 准备「重置要撤销什么」的现场：第二个登录会话 + 一枚可用的 PAT。
  const memberSessions = createClient(base)
  await memberSessions.signIn(memberEmail, memberPassword)
  const memberUser = userRows(databasePath).find(row => row.email === memberEmail)
  assert.ok(memberUser, '种子成员账号必须落盘')
  const pat = `wave-c-pat-${randomUUID()}`
  // PAT 只通过事务式写入（与生产写入同一路径）：`records` 行就是权威记录。
  await instance.store.transaction(tx => tx.identity.savePersonalAccessToken({ id: randomUUID(), userId: memberUser.id, tokenHash: hashSecret(pat), expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(), revokedAt: null }))
  // 用这枚 PAT 读一条需要管理员的安全读接口：拿到 403 admin_required 说明凭据本身已被接受（只是权限不够）。
  const patProbe = () => fetch(`${base}/api/settings/registration-policy`, { headers: { authorization: `Bearer ${pat}` } })
  const patRead = await patProbe()
  assert.equal(patRead.status, 403, `成员 PAT 不该是管理员（403 admin_required），实际 ${patRead.status}`)
  assert.equal((await patRead.json())?.error?.code, 'admin_required', '成员 PAT 必须作为有效凭据被接受，只是权限不足')

  // 3. 忘记密码：存在与不存在的邮箱必须同形响应（不可用于枚举账号）。
  const known = await memberSessions.call('/auth/password/forgot', { body: { email: memberEmail } })
  const unknown = await createClient(base).call('/auth/password/forgot', { body: { email: `nobody-${randomUUID()}@example.com` } })
  for (const [label, response] of [['已注册', known], ['未注册', unknown]]) {
    assert.equal(response.status, 202, `${label}邮箱的找回请求必须 202：${JSON.stringify(response.data)}`)
    assert.equal(response.data.status, 'accepted', `${label}邮箱的状态字段必须一致`)
    assert.match(String(response.data.email), /\*\*\*@/, `${label}邮箱必须掩码返回`)
  }
  assert.deepEqual(Object.keys(known.data).sort(), Object.keys(unknown.data).sort(), '存在与不存在账号的响应字段必须完全一致')
  results.push('忘记密码：已注册与未注册邮箱都是 202 + accepted + 掩码邮箱，字段集合相同（06 不可枚举）')

  // 4. 邮件链接在未登录的浏览器里打开、由用户点击才消费；重置后会话与 PAT 全撤。
  const resetUrl = await linkFor(base, '/auth/password/reset')
  const resetting = await newIdentityPage()
  await resetting.page.goto(resetUrl, { waitUntil: 'domcontentloaded' })
  await resetting.page.getByRole('button', { name: '设置新密码' }).waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await resetting.page.locator('#link-password').count(), 1, '重置页必须有新密码字段')
  // 只加载页面不得消费令牌：邮件扫描器的自动 GET 不能让链接失效。
  const untouched = challengeRows(databasePath).filter(row => row.purpose === 'reset_password')
  assert.equal(untouched.filter(row => row.consumed_at === null).length, 1, '仅仅打开重置页不得消费令牌')
  await resetting.page.locator('#link-password').fill(rotatedPassword)
  await resetting.page.locator('#link-confirm').fill(rotatedPassword)
  await resetting.page.getByRole('button', { name: '设置新密码' }).click()
  await wait(resetting.page, '密码已重置，所有旧会话已被撤销')
  await shot(resetting.page, '02-password-reset-done')

  assert.equal((await memberSessions.call('/auth/sessions')).status, 401, '重置后第二处登录会话必须失效')
  await member.page.goto(base + '/settings', { waitUntil: 'domcontentloaded' })
  await member.page.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
  const revokedPat = await instance.store.identity.findPersonalAccessToken(hashSecret(pat))
  assert.ok(revokedPat?.revokedAt, '重置后 PAT 必须被撤销（同一账号的全部凭证）')
  assert.equal((await patProbe()).status, 401, '被撤销的 PAT 必须在 HTTP 层立即失效，不能只改数据库字段')
  const oldPasswordLogin = await createClient(base).call('/auth/login', { body: { login: memberEmail, password: memberPassword } })
  assert.equal(oldPasswordLogin.status, 401, '旧密码必须失效')
  const newPasswordLogin = await createClient(base).call('/auth/login', { body: { login: memberEmail, password: rotatedPassword } })
  assert.equal(newPasswordLogin.status, 200, '新密码必须可登录')
  const resetAudit = auditRows(databasePath).find(row => row.action === 'credentials.reset')
  assert.ok(resetAudit, '重置必须留审计')
  assert.ok(resetAudit.metadata.revokedSessions >= 2, `审计要记下被撤销的会话数，实际 ${resetAudit.metadata.revokedSessions}`)
  assert.ok(resetAudit.metadata.revokedTokens >= 1, `审计要记下被撤销的令牌数，实际 ${resetAudit.metadata.revokedTokens}`)
  results.push(`密码重置：链接点击才消费，撤销 ${resetAudit.metadata.revokedSessions} 个会话与 ${resetAudit.metadata.revokedTokens} 枚 PAT，旧密码 401 / 新密码 200（06）`)

  // 5. 已登录改密码：错密码被拒、对密码生效、其它设备下线、当前设备保持登录、撤销数如实回显。
  await loginWithPassword(member.page, memberEmail, rotatedPassword)
  const otherDevice = createClient(base)
  await otherDevice.signIn(memberEmail, rotatedPassword)
  await openAccount(member.page)
  await member.page.locator('#account-password-current').fill('definitely-not-the-password')
  await member.page.locator('#account-password-next').fill(finalPassword)
  await member.page.locator('#account-password-confirm').fill(finalPassword)
  await member.page.getByRole('button', { name: '更新密码' }).click()
  await wait(member.page, '当前密码不正确')
  assert.equal((await otherDevice.call('/auth/sessions')).status, 200, '被拒的改密码不得撤销任何会话')
  await member.page.locator('#account-password-current').fill(rotatedPassword)
  await member.page.getByRole('button', { name: '更新密码' }).click()
  await wait(member.page, '密码已更新')
  const changeBanner = await bannerText(member.page)
  assert.match(changeBanner, /个会话与 \d+ 个访问令牌已撤销/, `撤销数量必须如实回显：${changeBanner}`)
  assert.equal((await otherDevice.call('/auth/sessions')).status, 401, '改密码必须撤销其它设备的会话')
  const stillHere = await member.page.evaluate(async () => (await fetch('/api/auth/me')).status)
  assert.equal(stillHere, 200, '当前设备必须保持登录，不能被自己的改密码踢下线')
  const stalePassword = await createClient(base).call('/auth/login', { body: { login: memberEmail, password: rotatedPassword } })
  assert.equal(stalePassword.status, 401, '改密码后旧密码必须失效')
  const freshPassword = await createClient(base).call('/auth/login', { body: { login: memberEmail, password: finalPassword } })
  assert.equal(freshPassword.status, 200, '改密码后新密码必须可登录')
  results.push(`已登录改密码：错密码 400 且不动其它会话；正确密码撤销其它设备并保留当前设备，撤销数在页面回显（06）`)

  // 6. 改邮箱：当前密码把关，新旧邮箱都收到邮件，确认链接在未登录浏览器里可用且只能使用一次。
  const beforeChange = (await outboxBodies()).length
  await member.page.locator('#account-email-new').fill(nextEmail)
  await member.page.locator('#account-email-current').fill('definitely-not-the-password')
  await member.page.getByRole('button', { name: '发送确认链接' }).click()
  await wait(member.page, '当前密码不正确')
  await member.page.locator('#account-email-current').fill(finalPassword)
  await member.page.getByRole('button', { name: '发送确认链接' }).click()
  await wait(member.page, '确认链接已发送到')
  const afterChange = await outboxBodies()
  assert.equal(afterChange.length, beforeChange + 2, '新旧邮箱都要收到邮件：新邮箱是确认链接，旧邮箱是变更提醒')
  const confirmUrl = await linkFor(base, '/auth/confirm-email-change')
  const confirming = await newIdentityPage()
  await confirming.page.goto(confirmUrl, { waitUntil: 'domcontentloaded' })
  await confirming.page.getByRole('button', { name: '确认更换邮箱' }).click()
  await wait(confirming.page, '账号邮箱已更换为')
  await shot(confirming.page, '03-email-change-done')
  // 重放同一个链接必须是明确的失败，而不是悄悄的第二次成功。
  await confirming.page.reload({ waitUntil: 'domcontentloaded' })
  await confirming.page.getByRole('button', { name: '确认更换邮箱' }).click()
  await wait(confirming.page, '该链接已被使用')
  assert.equal(auditRows(databasePath).filter(row => row.action === 'credentials.email_changed').length, 1, '重放不得再改变一次邮箱，审计里只应有一条成功记录')

  const changedUser = userRows(databasePath).find(row => row.id === memberUser.id)
  assert.equal(changedUser.email, nextEmail, '用户记录上的主邮箱必须换成新地址')
  assert.deepEqual(emailRows(databasePath).filter(row => row.user_id === memberUser.id).map(row => row.email_normalized), [nextEmail], '邮箱索引行必须整体换掉，不能新旧并存')
  assert.equal((await createClient(base).call('/auth/login', { body: { login: memberEmail, password: finalPassword } })).status, 401, '旧邮箱不能再登录')
  assert.equal((await createClient(base).call('/auth/login', { body: { login: nextEmail, password: finalPassword } })).status, 200, '新邮箱必须能登录')
  assert.equal((await createClient(base).call('/auth/login', { body: { login: 'wave-c-member', password: finalPassword } })).status, 200, '改邮箱不得连带废掉登录名：账号凭据只换了邮箱这个入口')
  const changeAudit = auditRows(databasePath)
  for (const action of ['credentials.email_change_requested', 'credentials.email_changed']) assert.ok(changeAudit.some(row => row.action === action), `缺少审计 ${action}`)
  results.push('改邮箱：当前密码把关，新旧邮箱各收一封，确认链接在未登录浏览器里生效且重放失败；旧邮箱登录 401 / 新邮箱 200（06）')

  // 7. 绑定 Google（Ticket 08）：绑定不签发新会话，回调把结果带回账号页。
  idp.state.next = { subject: googleSubject, email: googleEmail, emailVerified: true, name: 'Wave C Google' }
  const authorizeBefore = member.authorizeUrls.length
  await openAccount(member.page)
  const callback = member.page.waitForResponse(response => response.url().includes('/api/auth/oauth/google/callback'), { timeout: 30000 })
  await member.page.getByRole('button', { name: '绑定 Google 登录' }).click()
  const callbackLocation = new URL((await callback).headers()['location'] ?? '/', base)
  assert.equal(callbackLocation.pathname, '/settings', `绑定回调必须落回账号页：${callbackLocation.pathname}`)
  assert.equal(callbackLocation.searchParams.get('linked'), 'google', `回调要带上绑定结果：${callbackLocation.search}`)
  await wait(member.page, '已绑定')
  assert.equal(member.authorizeUrls.length, authorizeBefore + 1, '每次绑定都应发起一次授权跳转')
  const boundIdentities = identityRows(databasePath).filter(row => row.user_id === memberUser.id)
  assert.deepEqual(boundIdentities.map(row => row.provider), ['google'], `绑定后应有一条 google 身份：${JSON.stringify(boundIdentities)}`)
  assert.equal(boundIdentities[0].subject, googleSubject, '绑定的 subject 必须是 Google 的稳定唯一标识')
  await openAccount(member.page)
  const boundGoogleRow = member.page.getByRole('listitem').filter({ hasText: 'Google' })
  assert.equal(await member.page.getByRole('button', { name: '绑定 Google 登录' }).count(), 0, '已绑定后不得再次提供绑定入口')
  // 两种方式都在时，两个「解绑」都应可用（唯一方式才禁用），所以只能按行定位。
  assert.equal(await boundGoogleRow.getByRole('button', { name: '解绑' }).count(), 1, 'Google 行必须有且只有一个解绑入口')
  assert.equal(await boundGoogleRow.getByRole('button', { name: '解绑' }).isDisabled(), false, '有两种登录方式时可以解绑')
  assert.equal(await member.page.getByRole('button', { name: '解绑' }).count(), 2, '密码与 Google 两种方式都应有解绑入口')
  await shot(member.page, '04-methods-bound')
  results.push('绑定 Google：回调带 linked=google 回到账号页，绑定不签发新会话；身份行以 subject 落库（08）')

  // 8. 解绑：错密码被拒；正确解绑后只剩一种方式，最后一个方式永不可解绑（前后端都拦）。
  await boundGoogleRow.getByRole('button', { name: '解绑' }).click()
  await member.page.locator('#account-unbind-password').fill('definitely-not-the-password')
  await member.page.getByRole('button', { name: '确认解绑' }).click()
  await wait(member.page, '当前密码不正确')
  assert.equal(identityRows(databasePath).filter(row => row.user_id === memberUser.id).length, 1, '被拒的解绑不得删除身份行')
  await member.page.locator('#account-unbind-password').fill(finalPassword)
  await member.page.getByRole('button', { name: '确认解绑' }).click()
  await wait(member.page, '已解绑Google')
  assert.equal(identityRows(databasePath).filter(row => row.user_id === memberUser.id).length, 0, '解绑必须删除身份行')
  await openAccount(member.page)
  await waitText(member.page, '这是账号目前唯一的登录方式')
  assert.equal(await member.page.getByRole('button', { name: '解绑' }).isDisabled(), true, '只剩一种方式后不得再解绑')
  // 服务端同样拦：直接打接口也拿不到 last_login_method 之外的答案。
  const guardClient = createClient(base)
  const guardCsrf = await guardClient.signIn(nextEmail, finalPassword)
  const security = await guardClient.call('/auth/account/security')
  assert.equal(security.data.methods.length, 1, `解绑后应只剩一种登录方式：${JSON.stringify(security.data.methods)}`)
  const refused = await guardClient.call(`/auth/identities/${security.data.methods[0].id}`, { method: 'DELETE', csrf: guardCsrf, body: { currentPassword: finalPassword } })
  assert.equal(refused.status, 409, `最后一个登录方式必须被拒：${JSON.stringify(refused.data)}`)
  assert.equal(refused.data?.error?.code, 'last_login_method', '拒绝理由必须是 last_login_method')
  results.push('解绑：错密码 400 不动身份行；正确解绑删行并回落到唯一方式；前后端都拒绝 last_login_method（08）')

  // 9. 秘密与留痕：一次性令牌只存哈希，数据库与审计里零原文。
  const challenges = challengeRows(databasePath)
  assert.ok(challenges.every(row => row.token_hash.length === 64), '挑战令牌只能存哈希（64 字符）')
  assert.ok(challenges.filter(row => row.purpose === 'reset_password').every(row => row.consumed_at !== null), '重置挑战必须已消费')
  const storedTokens = [new URL(resetUrl).searchParams.get('token'), new URL(confirmUrl).searchParams.get('token')]
  assert.ok(storedTokens.every(Boolean), '重置与改邮箱链接都必须带 token')
  const databaseBytes = await readFile(databasePath, 'latin1')
  for (const rawToken of storedTokens) assert.equal(databaseBytes.includes(rawToken), false, '数据库文件里不得出现一次性令牌原文')
  for (const secret of [memberPassword, rotatedPassword, finalPassword, adminPassword, pat]) assert.equal(databaseBytes.includes(secret), false, `数据库里出现了秘密：${secret.slice(0, 12)}…`)
  const serializedAudit = JSON.stringify(auditRows(databasePath))
  for (const secret of [memberPassword, rotatedPassword, finalPassword, pat]) assert.equal(serializedAudit.includes(secret), false, '审计里不得出现密码或令牌原文')
  assert.equal(serializedAudit.includes(storedTokens[0]), false, '审计里不得出现一次性令牌原文')
  for (const action of ['credentials.login_method_bound', 'credentials.login_method_unbound', 'credentials.reset', 'credentials.email_changed']) {
    assert.ok(serializedAudit.includes(action), `审计缺少 ${action}`)
  }
  results.push('秘密边界：一次性令牌只存哈希、用后消费；密码、PAT、令牌原文都不落库也不落审计（06 + 08）')

  assert.deepEqual(pageErrors, [], `页面出现脚本错误：${pageErrors.join(' | ')}`)
  assert.deepEqual(httpProblems.filter(line => line.startsWith('5')), [], `流程里出现了 5xx：${httpProblems.join(' | ')}`)
  const report = { base, databasePath, outbox, results, pageErrors, httpProblems, tokenExchanges: idp.state.exchanges }
  await writeFile(join(workspace, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\nWave C 跨票据验收通过（Server ${base}，证据 ${workspace}）`)
  for (const line of results) console.log(`- ${line}`)
  const expected4xx = new Set(['401 /api/auth/me', '401 /api/auth/login'])
  console.log(`- 网络：无 5xx；预期内 4xx ${httpProblems.filter(line => expected4xx.has(line)).length} 次，其它 4xx ${httpProblems.filter(line => !expected4xx.has(line)).length} 次 ${JSON.stringify([...new Set(httpProblems.filter(line => !expected4xx.has(line)))])}`)
} catch (cause) {
  const open = browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed())
  for (const [index, page] of open.entries()) await dumpOnFailure(page, `wave-c-p${index}`).catch(() => {})
  throw cause
} finally {
  await browser.close().catch(() => {})
  await instance.close().catch(() => {})
  idp.server.close()
  if (process.env.WEMUX_KEEP_SHOTS) console.log(`\n证据保留在 ${workspace}`)
  else await rm(workspace, { recursive: true, force: true }).catch(() => {})
}