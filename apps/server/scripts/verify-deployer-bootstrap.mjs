// 首次部署验收（部署者即管理员）：全新实例、空数据库、只有部署声明 + 邮件投递，
// 部署者在真实浏览器里注册自己的邮箱、从本地出件箱取验证链接、激活后自动获得实例管理员权限。
// 这条路径是自托管的第一次启动，之前的脚本都先把管理员账号直接塞进数据库，所以另起一个脚本。
//   node --import tsx apps/server/scripts/verify-deployer-bootstrap.mjs
// 可覆盖：WEMUX_PLAYWRIGHT（playwright-core 入口）、WEMUX_CHROME（Chromium 可执行文件）、WEMUX_KEEP_SHOTS=1（保留截图）。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(serverRoot, '../..')
const webDist = join(repositoryRoot, 'apps/web/dist')
const playwrightEntry = process.env.WEMUX_PLAYWRIGHT ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs'
const chromePath = process.env.WEMUX_CHROME ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'

// 部署者声明的邮箱就是第一个管理员，也是第一个账号：这里不预先落盘任何用户。
const deployerEmail = 'deployer@wemux.test'
const deployerName = '王部署'
const deployerPassword = 'deployer-own-password-value'
const strangerEmail = 'stranger@example.com'

if (!existsSync(join(webDist, 'index.html'))) throw new Error(`缺少 Web 构建产物：${webDist}。先运行 npm run build:web。`)
const { chromium } = await import(playwrightEntry)

const workspace = await mkdtemp(join(tmpdir(), 'wemux-deployer-bootstrap-'))
const screenshotDir = process.env.WEMUX_KEEP_SHOTS ? join(workspace, 'screenshots') : workspace
await mkdir(screenshotDir, { recursive: true })
const outbox = join(workspace, 'outbox')
const databasePath = join(workspace, 'server.sqlite')
const port = 8800 + Math.floor(Math.random() * 300)
const base = `http://127.0.0.1:${port}`
const logPath = join(workspace, 'server.log')
const log = createWriteStream(logPath)
const server = spawn(process.execPath, ['--import', 'tsx', join(serverRoot, 'src/main.ts')], {
  cwd: serverRoot,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    WEMUX_ADMIN_EMAILS: deployerEmail,
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
    return { name: entry.name, text: Buffer.from(raw.slice(raw.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString('utf8') }
  }))
}
const linkFor = async path => {
  for (const mail of [...await outboxBodies()].reverse()) {
    const match = new RegExp(`(${base.replace(/[/:.]/g, '\\$&')}${path.replace('/', '\\/')}\\?token=[A-Za-z0-9_-]+)`).exec(mail.text)
    if (match) return match[1]
  }
  throw new Error(`出件箱里没有 ${path} 链接`)
}

const results = []
const browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ['--no-sandbox'] })
const pageErrors = []
const track = page => {
  page.on('pageerror', error => pageErrors.push(String(error)))
  // 刻意制造的失败请求（401/403 探针）会打出 "Failed to load resource"，那不是脚本异常。
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
const note = async (page, label) => {
  const text = (await page.locator('body').innerText()).replace(/\s*\n\s*/g, ' | ').slice(0, 400)
  results.push(`文案 ${label}：${text}`)
}

const deployer = await newSession()
try {
  await waitForServer()

  // 1. 全新实例的落地页：默认策略是仅邀请，但声明邮箱还没建号，部署者必须能看到注册入口。
  await deployer.page.goto(base + '/', { waitUntil: 'domcontentloaded' })
  await deployer.page.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
  const landingText = await deployer.page.locator('body').innerText()
  assert.match(landingText, /管理员已由部署声明，但对应账号还没建立/, '落地页必须告诉部署者该用哪个邮箱（不泄露邮箱本身）')
  assert.match(landingText, /部署时声明的管理员邮箱是例外/, '仅邀请策略下必须说明声明邮箱是例外')
  const registerEntry = deployer.page.getByRole('button', { name: '还没有账号？用邮箱注册' })
  await registerEntry.waitFor({ state: 'visible', timeout: 15000 })
  await shot(deployer.page, '01-fresh-instance-register-entry')
  await note(deployer.page, '全新实例落地页')
  results.push('全新实例（默认仅邀请）：注册入口可达，页面说明声明邮箱例外')

  // 2. 例外只覆盖声明邮箱：别的邮箱直连 API 仍被策略拒绝（界面可达不等于策略放宽）。
  const stranger = await deployer.page.evaluate(async ({ email }) => {
    const response = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, displayName: '路人', password: 'stranger-password-value' }) })
    return { status: response.status, body: await response.text() }
  }, { email: strangerEmail })
  assert.equal(stranger.status, 403, `仅邀请策略下未声明邮箱必须被拒，实际 ${stranger.status} ${stranger.body}`)
  assert.match(stranger.body, /invitation/, `拒绝理由应是邀请制，实际 ${stranger.body}`)
  results.push('仅邀请策略未被放宽：未声明邮箱注册 403 invitation_required')

  // 3. 部署者走真实界面注册自己声明的邮箱。
  await registerEntry.click()
  await deployer.page.locator('#auth-email').fill(deployerEmail)
  await deployer.page.locator('#auth-display').fill(deployerName)
  await deployer.page.locator('#auth-password').fill(deployerPassword)
  await deployer.page.locator('#auth-confirm').fill(deployerPassword)
  const registerFormText = await deployer.page.locator('body').innerText()
  assert.match(registerFormText, /实例管理员权限/, '注册表单必须说明声明邮箱验证后即获得实例管理员权限')
  await deployer.page.getByRole('button', { name: '发送验证邮件' }).click()
  await deployer.page.getByText('验证邮件已发送').waitFor({ state: 'visible', timeout: 15000 })
  const sentText = await deployer.page.getByRole('status').innerText()
  assert.match(sentText, /只能使用一次/)
  await shot(deployer.page, '02-deployer-registered')
  results.push('部署者用声明邮箱注册：进入待验证状态，提示说明验证后即管理员')

  // 4. 邮件里的链接是真实前端路由；打开与刷新都不消费，点击才激活。
  const verifyUrl = await linkFor('/auth/verify-email')
  const verifier = await newSession()
  await verifier.page.goto(verifyUrl, { waitUntil: 'domcontentloaded' })
  await verifier.page.getByRole('button', { name: '确认并激活账号' }).waitFor({ state: 'visible', timeout: 15000 })
  await verifier.page.reload({ waitUntil: 'domcontentloaded' })
  await verifier.page.getByRole('button', { name: '确认并激活账号' }).waitFor({ state: 'visible', timeout: 15000 })
  const beforeClick = await verifier.page.evaluate(async () => (await fetch('/api/auth/me')).status)
  assert.equal(beforeClick, 401, '仅打开验证页不得签发会话')
  await verifier.page.getByRole('button', { name: '确认并激活账号' }).click()
  await verifier.page.locator('nav').first().waitFor({ state: 'visible', timeout: 15000 })
  await shot(verifier.page, '03-deployer-activated')
  results.push('验证链接指向前端路由：打开与刷新不消费，点击后激活并直接进入控制台')

  // 5. 激活后的账号就是实例管理员，并且能进集群控制面。
  const me = await verifier.page.evaluate(async () => { const response = await fetch('/api/auth/me'); return { status: response.status, body: await response.json() } })
  assert.equal(me.status, 200)
  assert.equal(me.body.user.email, deployerEmail)
  assert.equal(me.body.instanceAdministrator, true, '声明邮箱激活后必须是实例管理员')
  const projects = await verifier.page.evaluate(async () => (await fetch('/api/projects')).status)
  assert.equal(projects, 200, '管理员必须能读集群控制面')
  await verifier.page.goto(base + '/settings', { waitUntil: 'domcontentloaded' })
  await verifier.page.getByRole('heading', { name: '注册与邮件' }).waitFor({ state: 'visible', timeout: 15000 })
  const policy = await verifier.page.evaluate(async () => { const response = await fetch('/api/settings/registration-policy'); return { status: response.status, body: await response.json() } })
  assert.equal(policy.status, 200)
  assert.equal(policy.body.policy, 'invite_only', '部署者没有改策略，新实例默认仍是仅邀请')
  await shot(verifier.page, '04-admin-console')
  await note(verifier.page, '管理员设置页')
  results.push(`激活后 /api/auth/me 显示 instanceAdministrator=true，能读 /api/projects（${projects}）与注册策略；策略默认值未被改动`)

  // 6. 审计说清楚“为什么这个邮箱能注册”，并且这是一次真实的授权提升。
  const { SqliteServerStore } = await import('../src/storage/sqlite/store.ts')
  const reader = new SqliteServerStore(databasePath)
  const audit = await reader.identity.listAudit(200)
  reader.close()
  const actions = audit.map(entry => entry.action)
  assert.ok(actions.includes('identity.registration_allowed'), `审计缺少放行记录：${actions.join(',')}`)
  const allowed = audit.find(entry => entry.action === 'identity.registration_allowed')
  assert.equal(allowed.metadata?.reason, 'declared_administrator', `放行理由必须是声明邮箱：${JSON.stringify(allowed.metadata)}`)
  assert.match(String(allowed.metadata?.email ?? ''), /^d\*\*\*@wemux\.test$/, '审计里的邮箱必须脱敏')
  assert.ok(actions.includes('instance.administrator_assigned'), `审计缺少管理员授予记录：${actions.join(',')}`)
  const granted = audit.find(entry => entry.action === 'instance.administrator_assigned')
  assert.equal(granted.metadata?.channel, 'declared', `管理员授予渠道必须是声明：${JSON.stringify(granted.metadata)}`)
  assert.equal(granted.metadata?.email, deployerEmail, '授予记录应记下哪个邮箱获得管理员')
  results.push(`审计可追溯：identity.registration_allowed(reason=declared_administrator)、instance.administrator_assigned；动作清单 ${[...new Set(actions)].join(', ')}`)

  // 7. 引导令牌这套东西连路由都不该存在。
  const setupStatus = await verifier.page.evaluate(async () => (await fetch('/api/auth/setup', { method: 'POST' })).status)
  assert.equal(setupStatus, 404, `引导令牌路由必须彻底消失，实际 ${setupStatus}`)
  results.push('引导令牌路由已消失：POST /api/auth/setup = 404')

  assert.deepEqual(pageErrors, [], `页面出现脚本错误：${pageErrors.join(' | ')}`)

  console.log(['', '首次部署（部署者即管理员）验收结果：', ...results.map(line => `  - ${line}`), '', `日志：${logPath}`, ''].join('\n'))
  console.log('PASS 部署者用声明邮箱自举为实例管理员，无需引导令牌，策略例外有审计')
} finally {
  await browser.close().catch(() => {})
  server.kill('SIGTERM')
  await new Promise(resolve => setTimeout(resolve, 300))
  if (!process.env.WEMUX_KEEP_SHOTS) await rm(workspace, { recursive: true, force: true })
  else console.log(`保留现场：${workspace}`)
}