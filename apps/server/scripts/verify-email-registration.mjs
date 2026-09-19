// Ticket 05 真实浏览器验收：注册策略（仅邀请/开放/关闭）→ 邮箱注册 → 验证链接不自动消费 →
// 激活并登录 → 新账号无既有权限 → 找回密码（旧密码失效）→ 邮件链接指向真实前端路由。
// playwright-core 故意不是仓库依赖（会连带下载浏览器），用环境变量指到已有安装：
//   node --import tsx apps/server/scripts/verify-email-registration.mjs
// 可覆盖：WEMUX_PLAYWRIGHT（playwright-core 入口）、WEMUX_CHROME（Chromium 可执行文件）、WEMUX_KEEP_SHOTS=1（保留截图）。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(serverRoot, '../..')
const webDist = join(repositoryRoot, 'apps/web/dist')
const playwrightEntry = process.env.WEMUX_PLAYWRIGHT ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs'
const chromePath = process.env.WEMUX_CHROME ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'

const administratorEmail = 'verify-admin@wemux.test'
const adminPassword = 'verify-admin-password-value'
const memberEmail = 'ada@example.com'
const memberName = 'Ada Lovelace'
const memberPassword = 'verify-member-password-value'
const rotatedPassword = 'verify-member-rotated-password'

if (!existsSync(join(webDist, 'index.html'))) throw new Error(`缺少 Web 构建产物：${webDist}。先运行 npm run build:web。`)
const { chromium } = await import(playwrightEntry)

const workspace = await mkdtemp(join(tmpdir(), 'wemux-email-registration-'))
const screenshotDir = process.env.WEMUX_KEEP_SHOTS ? join(workspace, 'screenshots') : workspace
await mkdir(screenshotDir, { recursive: true })
const outbox = join(workspace, 'outbox')
const databasePath = join(workspace, 'server.sqlite')
const port = 8500 + Math.floor(Math.random() * 300)
const base = `http://127.0.0.1:${port}`
const logPath = join(workspace, 'server.log')
const log = await import('node:fs').then(({ createWriteStream }) => createWriteStream(logPath))
// 部署声明的管理员账号先落盘（生产里是「声明邮箱 → 注册 → 验证邮件」），之后的登录与会话全走真实路径。
{
  const { SqliteServerStore } = await import('../src/storage/sqlite/store.ts')
  const { seedLocalAccount } = await import('../src/test/fixtures/administrator.ts')
  const store = new SqliteServerStore(databasePath)
  await seedLocalAccount(store, { username: administratorEmail, email: administratorEmail, password: adminPassword, administrator: true })
  store.close()
}
const server = spawn(process.execPath, ['--import', 'tsx', join(serverRoot, 'src/main.ts')], {
  cwd: serverRoot,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    WEMUX_ADMIN_EMAILS: administratorEmail,
    WEMUX_DATABASE_PATH: databasePath,
    WEMUX_WEB_DIST: webDist,
    // 本地出件箱是真实投递到磁盘目录：从 .eml 里取链接，和收件人点击的是同一串地址。
    WEMUX_MAIL_OUTBOX: outbox,
    WEMUX_SMTP_FROM: 'Wemux Lite <no-reply@wemux.test>',
    WEMUX_PUBLIC_URL: base,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.pipe(log)
server.stderr.pipe(log)

const waitForServer = async () => {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return
    } catch { /* 还没起来 */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Server 在 30 秒内没有就绪，日志见 ${logPath}`)
}

/** 读最新一封邮件正文（base64 折行的 MIME 体），与测试辅助保持一致。 */
const outboxBodies = async () => {
  const names = (await readdir(outbox)).filter(name => name.endsWith('.eml'))
  const entries = await Promise.all(names.map(async name => ({ name, written: (await stat(join(outbox, name))).mtimeMs })))
  entries.sort((a, b) => a.written - b.written || a.name.localeCompare(b.name))
  return Promise.all(entries.map(async entry => {
    const raw = await readFile(join(outbox, entry.name), 'utf8')
    return Buffer.from(raw.slice(raw.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString('utf8')
  }))
}
const linkFor = async path => {
  for (const text of [...await outboxBodies()].reverse()) {
    const match = new RegExp(`(${base.replace(/[/:.]/g, '\\$&')}${path.replace('/', '\\/')}\\?token=[A-Za-z0-9_-]+)`).exec(text)
    if (match) return match[1]
  }
  throw new Error(`出件箱里没有 ${path} 链接`)
}

const results = []
const browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ['--no-sandbox'] })
const pageErrors = []
const track = page => {
  page.on('pageerror', error => pageErrors.push(String(error)))
  // 刻意制造的失败请求（401/403/404 探针）会打出 "Failed to load resource"，那不是脚本异常。
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) pageErrors.push(`console: ${message.text()}`) })
}
const newSession = async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  track(page)
  return { context, page }
}
const shot = async (page, name) => {
  const file = join(screenshotDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  results.push(`截图 ${file}`)
}
/** 把关键页面上的可见文案收进报告：截图之外还要有可搜索的文本证据。 */
const note = async (page, label) => {
  const text = (await page.locator('body').innerText()).replace(/\s*\n\s*/g, ' | ').slice(0, 500)
  results.push(`文案 ${label}：${text}`)
}
const signIn = async (page, login, password) => {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('#auth-login').fill(login)
  await page.locator('#auth-password').fill(password)
  await page.getByRole('button', { name: '登录' }).click()
}

let admin = await newSession()
try {
  await waitForServer()

  // 1. 部署声明的管理员登录。默认策略是仅邀请：注册按钮不出现，直连 API 也必须拒绝。
  await signIn(admin.page, administratorEmail, adminPassword)
  await admin.page.locator('nav').first().waitFor({ state: 'visible', timeout: 15000 })
  results.push('声明邮箱的管理员登录成功，进入控制台')

  const guest = await newSession()
  await guest.page.goto(base + '/', { waitUntil: 'domcontentloaded' })
  await guest.page.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await guest.page.getByRole('button', { name: '还没有账号？用邮箱注册' }).count(), 0, '仅邀请模式下不得出现自助注册入口')
  assert.match(await guest.page.getByText('本实例目前只允许邀请注册').innerText(), /只允许邀请注册/, '页面必须说明为什么没有注册入口')
  const inviteOnly = await guest.page.evaluate(async () => (await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nobody@example.com', displayName: 'Nobody', password: 'nobody-password-value-x' }) })).status)
  assert.equal(inviteOnly, 403, `仅邀请模式下直连 API 必须拒绝，实际 ${inviteOnly}`)
  await shot(guest.page, '01-invite-only-landing')
  await note(guest.page, '仅邀请落地页')
  results.push('默认仅邀请：界面无注册入口，直连 API 403（策略不靠隐藏按钮）')

  // 2. 管理员开放注册：页面徽章与按钮状态随之改变。
  await admin.page.goto(base + '/settings', { waitUntil: 'domcontentloaded' })
  await admin.page.getByRole('heading', { name: '注册与邮件' }).waitFor({ state: 'visible', timeout: 15000 })
  const policySection = admin.page.locator('section', { hasText: '注册与邮件' })
  const policyBefore = await admin.page.evaluate(async () => { const response = await fetch('/api/settings/registration-policy'); return { status: response.status, body: await response.text() } })
  assert.equal(policyBefore.status, 200, `读取注册策略失败：${JSON.stringify(policyBefore)}`)
  assert.equal(JSON.parse(policyBefore.body).policy, 'invite_only', `新实例默认策略必须是仅邀请，实际 ${policyBefore.body}`)
  await policySection.getByRole('button', { name: '开放注册' }).click({ timeout: 15000 })
  await policySection.getByText('管理员显式设置').waitFor({ state: 'visible', timeout: 10000 })
  results.push('管理员在账号页把注册策略改为开放注册')

  // 3. 访客注册：不再泄漏账号是否存在，只承诺“如果可用于注册”。
  await guest.page.goto(base + '/', { waitUntil: 'domcontentloaded' })
  await guest.page.getByRole('button', { name: '还没有账号？用邮箱注册' }).waitFor({ state: 'visible', timeout: 15000 })
  await guest.page.getByRole('button', { name: '还没有账号？用邮箱注册' }).click()
  await guest.page.locator('#auth-email').fill(memberEmail)
  await guest.page.locator('#auth-display').fill(memberName)
  await guest.page.locator('#auth-password').fill(memberPassword)
  await guest.page.locator('#auth-confirm').fill(memberPassword)
  await guest.page.getByRole('button', { name: '发送验证邮件' }).click()
  await guest.page.getByText('验证邮件已发送').waitFor({ state: 'visible', timeout: 15000 })
  const sentText = await guest.page.getByRole('status').innerText()
  assert.match(sentText, /如果 a\*\*\*@example\.com 可以用于注册/, '提示必须是无枚举措辞（邮箱也脱敏）')
  assert.ok(!sentText.includes(memberEmail), '提示里不得回显完整邮箱')
  assert.match(sentText, /只能使用一次/)
  await shot(guest.page, '02-registration-accepted')
  await note(guest.page, '注册已受理')
  const beforeVerifyLogin = await guest.page.evaluate(async () => (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'ada@example.com', password: 'verify-member-password-value' }) })).status)
  assert.equal(beforeVerifyLogin, 401, '未验证邮箱不得登录')
  results.push('注册进入待验证状态：界面无枚举措辞，未验证前无法登录')

  // 4. 验证链接指向真实前端路由；页面加载（含刷新）不得消费一次性令牌，只有点击才消费。
  const verifyUrl = await linkFor('/auth/verify-email')
  const verifier = await newSession()
  await verifier.page.goto(verifyUrl, { waitUntil: 'domcontentloaded' })
  await verifier.page.getByRole('button', { name: '确认并激活账号' }).waitFor({ state: 'visible', timeout: 15000 })
  await verifier.page.reload({ waitUntil: 'domcontentloaded' })
  await verifier.page.getByRole('button', { name: '确认并激活账号' }).waitFor({ state: 'visible', timeout: 15000 })
  const stillGuest = await verifier.page.evaluate(async () => (await fetch('/api/auth/me')).status)
  assert.equal(stillGuest, 401, '仅打开验证页不得自动激活或签发会话（邮件扫描器只 GET）')
  await shot(verifier.page, '03-verify-page-not-consumed')
  await note(verifier.page, '验证页未消费')
  await verifier.page.getByRole('button', { name: '确认并激活账号' }).click()
  await verifier.page.locator('nav').first().waitFor({ state: 'visible', timeout: 15000 })
  results.push('验证链接指向前端路由；打开与刷新都不消费，点击后才激活并登录')

  // 5. 新账号没有任何既有 Team/Project/Task 权限：用户态账号目前不能进集群控制面，
  // 但账号自身的能力（读自己、管自己会话）必须正常。
  const memberProjects = await verifier.page.evaluate(async () => { const response = await fetch('/api/projects'); return { status: response.status, body: await response.json() } })
  assert.equal(memberProjects.status, 403, `新账号不得读取既有项目：${JSON.stringify(memberProjects)}`)
  assert.equal(memberProjects.body.error.code, 'admin_required', '拒绝理由必须是“需要实例管理员”（而非自动带上默认团队）')
  const memberSelf = await verifier.page.evaluate(async () => { const me = await fetch('/api/auth/me'); const sessions = await fetch('/api/auth/sessions'); return { me: me.status, sessions: sessions.status, body: await me.json() } })
  assert.equal(memberSelf.me, 200, '账号自身必须可读')
  assert.equal(memberSelf.sessions, 200, '账号必须能管自己的登录会话')
  assert.equal(memberSelf.body.user.email, memberEmail)
  assert.equal(memberSelf.body.instanceAdministrator, false, '自助注册账号不得成为实例管理员')
  await verifier.page.goto(base + '/projects', { waitUntil: 'domcontentloaded' })
  await verifier.page.getByRole('alert').waitFor({ state: 'visible', timeout: 20000 })
  assert.match(await verifier.page.getByRole('alert').innerText(), /实例管理员|拒绝|权限/)
  assert.equal(await verifier.page.locator('a[href^="/projects/"]').count(), 0, '列表里不得出现任何项目链接')
  await shot(verifier.page, '04-new-account-no-project-access')
  await note(verifier.page, '新账号控制面拒绝')
  results.push('新账号不继承任何既有项目：控制面 403 admin_required，且本人资料/会话可用（非管理员）')

  // 6. 重复注册同一邮箱：界面提示与首次一致，不泄漏账号存在。
  const duplicate = await newSession()
  await duplicate.page.goto(base + '/', { waitUntil: 'domcontentloaded' })
  await duplicate.page.getByRole('button', { name: '还没有账号？用邮箱注册' }).waitFor({ state: 'visible', timeout: 15000 })
  await duplicate.page.getByRole('button', { name: '还没有账号？用邮箱注册' }).click()
  await duplicate.page.locator('#auth-email').fill(memberEmail)
  await duplicate.page.locator('#auth-display').fill(memberName)
  await duplicate.page.locator('#auth-password').fill('another-member-password')
  await duplicate.page.locator('#auth-confirm').fill('another-member-password')
  await duplicate.page.getByRole('button', { name: '发送验证邮件' }).click()
  await duplicate.page.getByText('验证邮件已发送').waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await duplicate.page.getByRole('status').innerText(), sentText, '重复注册的界面提示必须与首次完全一致')
  // 已存在账号的密码不被改写。
  const unchanged = await duplicate.page.evaluate(async () => (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'ada@example.com', password: 'verify-member-password-value' }) })).status)
  assert.equal(unchanged, 200, '重复注册不得改写已存在账号的密码')
  results.push('重复注册界面提示一致、密码不被改写（无枚举信号）')

  // 7. 找回密码：重置页不自动消费；提交后旧密码失效、旧会话被撤销。
  await verifier.page.goto(base + '/settings', { waitUntil: 'domcontentloaded' })
  await verifier.page.getByRole('button', { name: '退出登录' }).click()
  await verifier.page.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
  await verifier.page.getByRole('button', { name: /忘记密码/ }).click()
  await verifier.page.locator('#auth-email').fill(memberEmail)
  await verifier.page.getByRole('button', { name: '发送重置链接' }).click()
  await verifier.page.getByText('重置链接已发送').waitFor({ state: 'visible', timeout: 15000 })
  const resetUrl = await linkFor('/auth/password/reset')
  const resetter = await newSession()
  await resetter.page.goto(resetUrl, { waitUntil: 'domcontentloaded' })
  await resetter.page.locator('#link-password').waitFor({ state: 'visible', timeout: 15000 })
  await resetter.page.reload({ waitUntil: 'domcontentloaded' })
  await resetter.page.locator('#link-password').fill(rotatedPassword)
  await resetter.page.locator('#link-confirm').fill(rotatedPassword)
  await resetter.page.getByRole('button', { name: '设置新密码' }).click()
  await resetter.page.getByText('密码已重置').waitFor({ state: 'visible', timeout: 15000 })
  await shot(resetter.page, '05-password-reset-done')
  await note(resetter.page, '密码已重置')
  const revoked = await verifier.page.evaluate(async () => (await fetch('/api/auth/me')).status)
  assert.equal(revoked, 401, '重置后旧会话必须被撤销')
  const staleLogin = await newSession()
  await signIn(staleLogin.page, memberEmail, memberPassword)
  await staleLogin.page.getByRole('alert').waitFor({ state: 'visible', timeout: 10000 })
  assert.match(await staleLogin.page.getByRole('alert').innerText(), /账号或密码不正确/)
  await signIn(resetter.page, memberEmail, rotatedPassword)
  await resetter.page.locator('nav').first().waitFor({ state: 'visible', timeout: 15000 })
  results.push('找回密码：页面不自动消费令牌；重置后旧密码与旧会话全部失效，新密码可登录')

  // 8. 关闭注册：界面入口消失且 API 拒绝，已登录账号不受影响。
  await admin.page.goto(base + '/settings', { waitUntil: 'domcontentloaded' })
  await admin.page.getByRole('heading', { name: '注册与邮件' }).waitFor({ state: 'visible', timeout: 15000 })
  await policySection.getByRole('button', { name: '关闭注册' }).click()
  await policySection.getByText('管理员显式设置').waitFor({ state: 'visible', timeout: 10000 })
  const closed = await newSession()
  await closed.page.goto(base + '/', { waitUntil: 'domcontentloaded' })
  await closed.page.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await closed.page.getByRole('button', { name: '还没有账号？用邮箱注册' }).count(), 0, '关闭注册后不得出现注册入口')
  assert.match(await closed.page.getByText('本实例已关闭注册').innerText(), /已关闭注册/)
  const closedApi = await closed.page.evaluate(async () => (await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'later@example.com', displayName: 'Later', password: 'later-password-value-x' }) })).status)
  assert.equal(closedApi, 403, `关闭注册后直连 API 必须拒绝，实际 ${closedApi}`)
  await shot(closed.page, '06-registration-closed')
  await note(closed.page, '关闭注册落地页')
  assert.equal((await resetter.page.evaluate(async () => (await fetch('/api/auth/me')).status)), 200, '策略变更不影响已登录账号')
  results.push('关闭注册：界面入口消失、API 403，已登录账号不受影响')

  assert.deepEqual(pageErrors, [], `页面不应出现 JS 错误：${pageErrors.join(' | ')}`)

  const report = { base, databasePath, outbox, screenshotDir, results, pageErrors }
  await writeFile(join(workspace, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\n真实浏览器验收通过（Server ${base}，证据 ${workspace}）`)
  for (const line of results) console.log(`- ${line}`)
} finally {
  await admin.context.close().catch(() => {})
  await browser.close().catch(() => {})
  server.kill('SIGTERM')
  await new Promise(resolve => server.on('close', resolve))
  if (process.env.WEMUX_KEEP_SHOTS) {
    console.log(`\n证据保留在 ${workspace}`)
  } else {
    const logText = await readFile(logPath, 'utf8').catch(() => '')
    if (logText) console.log(`\nServer 日志（截断）：\n${logText.split('\n').slice(-8).join('\n')}`)
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  }
}