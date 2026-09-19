// Ticket 04 真实浏览器验收：部署声明的管理员登录 → 工作台 → 退出 → 登录 → 设备会话撤销 → 刷新保持 → 主机本地恢复。
// playwright-core 故意不是仓库依赖（会连带下载浏览器），用环境变量指到已有安装：
//   node --import tsx apps/server/scripts/verify-account-login.mjs
// 可覆盖：WEMUX_PLAYWRIGHT（playwright-core 入口）、WEMUX_CHROME（Chromium 可执行文件）、WEMUX_KEEP_SHOTS=1（保留截图）。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(serverRoot, '../..')
const webDist = join(repositoryRoot, 'apps/web/dist')
const playwrightEntry = process.env.WEMUX_PLAYWRIGHT ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs'
const chromePath = process.env.WEMUX_CHROME ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'

const administratorEmail = 'verify-owner@example.com'
const username = administratorEmail
const password = 'verify-owner-password-value'
const newPassword = 'verify-owner-rotated-password'

if (!existsSync(join(webDist, 'index.html'))) throw new Error(`缺少 Web 构建产物：${webDist}。先运行 npm run build:web。`)
const { chromium } = await import(playwrightEntry)

const workspace = await mkdtemp(join(tmpdir(), 'wemux-account-login-'))
const screenshotDir = process.env.WEMUX_KEEP_SHOTS ? join(workspace, 'screenshots') : workspace
await mkdir(screenshotDir, { recursive: true })
const databasePath = join(workspace, 'server.sqlite')
const port = 8200 + Math.floor(Math.random() * 300)
const logPath = join(workspace, 'server.log')
const log = await import('node:fs').then(({ createWriteStream }) => createWriteStream(logPath))
// 部署声明的管理员账号先落盘：生产里这一步是「设置 WEMUX_ADMIN_EMAILS → 该邮箱注册并验证」，脚本跳过邮件环节，
// 之后的登录、会话、恢复全部走真实生产路径。
{
  const { SqliteServerStore } = await import('../src/storage/sqlite/store.ts')
  const { seedLocalAccount } = await import('../src/test/fixtures/administrator.ts')
  const store = new SqliteServerStore(databasePath)
  await seedLocalAccount(store, { username: administratorEmail, email: administratorEmail, password, administrator: true })
  store.close()
}
const server = spawn(process.execPath, ['--import', 'tsx', join(serverRoot, 'src/main.ts')], {
  cwd: serverRoot,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', WEMUX_ADMIN_EMAILS: administratorEmail, WEMUX_DATABASE_PATH: databasePath, WEMUX_WEB_DIST: webDist },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.pipe(log)
server.stderr.pipe(log)
const base = `http://127.0.0.1:${port}`

const waitForServer = async () => {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`${base}/api/health`)
      if (response.ok) return
    } catch { /* 还没起来 */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Server 在 30 秒内没有就绪，日志见 ${logPath}`)
}

const results = []
const browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ['--no-sandbox'] })
let context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
let page = await context.newPage()
const pageErrors = []
page.on('pageerror', error => pageErrors.push(String(error)))
// 刻意制造的失败请求（401/403/404 探针）会打出 "Failed to load resource"，那不是脚本异常。
page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) pageErrors.push(`console: ${message.text()}`) })

const shot = async name => {
  const file = join(screenshotDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  results.push(`截图 ${file}`)
}

try {
  await waitForServer()

  // 1. 首屏必须是页级内联登录表单，而不是弹窗，也不再有任何引导令牌入口。
  await page.goto(base + '/', { waitUntil: 'networkidle' })
  await page.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await page.locator('#auth-bootstrap').count(), 0, '引导令牌字段必须彻底消失')
  assert.equal(await page.locator('dialog').count(), 0, '首屏不得是弹窗')
  results.push('首屏内联表单：邮箱（或账号名）+ 密码，无引导令牌字段（无弹窗）')

  // 2. 用部署声明的管理员邮箱登录，进入工作台。
  await page.locator('#auth-login').fill(administratorEmail)
  await page.locator('#auth-password').fill(password)
  await page.getByRole('button', { name: '登录' }).click()
  await page.locator('nav').first().waitFor({ state: 'visible', timeout: 15000 })
  await shot('01-signed-in-console')
  const cookies = await context.cookies(base)
  const loginCookie = cookies.find(cookie => cookie.name === 'wemux_login_session')
  assert.ok(loginCookie, '登录后必须下发登录会话 Cookie')
  assert.equal(loginCookie.httpOnly, true, '登录会话 Cookie 必须是 HttpOnly')
  assert.equal(loginCookie.sameSite, 'Lax', '登录会话 Cookie 必须是 SameSite=Lax')
  assert.equal(loginCookie.path, '/', '登录会话 Cookie 路径必须是 /')
  assert.ok(!loginCookie.domain.startsWith('.'), '登录会话 Cookie 必须是 host-only')
  results.push(`Cookie 属性：HttpOnly/SameSite=Lax/Path=//host-only，name=${loginCookie.name}`)
  const readableSecrets = await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))
  const storageDump = JSON.stringify(readableSecrets)
  assert.ok(!storageDump.includes(password), `浏览器存储不得保存密码：${storageDump}`)
  assert.ok(!storageDump.includes('wemux_login_session'), '浏览器存储不得保存登录令牌')
  results.push('浏览器存储不含密码或登录令牌（登录态只在 HttpOnly Cookie）')

  // 3. 换一个干净浏览器：只看到登录表单；引导令牌入口与 `/api/auth/setup` 端点都已不存在。
  const second = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const secondPage = await second.newPage()
  await secondPage.goto(base + '/', { waitUntil: 'networkidle' })
  await secondPage.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await secondPage.locator('#auth-bootstrap').count(), 0, '实例不再有任何引导令牌表单')
  // 先等一个依赖 `/auth/options` 的文案出现（默认策略下是注册受限提示），
  // 否则下面的断言会因为选项尚未到达而空真。
  await secondPage.getByText(/本实例目前只允许邀请注册|本实例已关闭注册|邮件投递不可用|还没有账号？用邮箱注册/).first().waitFor({ state: 'visible', timeout: 15000 })
  const retired = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'intruder-owner', password: 'another-long-password-value' }) })
  // 已删除的路由不会落到业务处理：未知 /api 路径先撞鉴权 401，再是 404（两者都不是 2xx/409）。
  assert.ok([401, 404].includes(retired.status), `引导令牌认领端点必须已经删除，实际 ${retired.status}`)
  results.push('引导令牌入口与 /api/auth/setup 端点均已删除（未鉴权 401/未知路由 404），新浏览器只看到登录表单')

  // 4. 错误密码给出明确失败提示，而不是静默通过。
  await secondPage.locator('#auth-login').fill(username)
  await secondPage.locator('#auth-password').fill('wrong-password-value-x')
  await secondPage.getByRole('button', { name: '登录' }).click()
  const alert = secondPage.getByRole('alert')
  await alert.waitFor({ state: 'visible', timeout: 10000 })
  assert.match(await alert.innerText(), /账号或密码不正确/)
  results.push('错误密码显示明确的失败提示，不进入工作台')

  // 5. 正确登录，进入工作台；页面脚本读不到登录令牌。
  await secondPage.locator('#auth-password').fill(password)
  await secondPage.getByRole('button', { name: '登录' }).click()
  await secondPage.locator('nav').first().waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await secondPage.evaluate(() => document.cookie.includes('wemux_login_session')), false, 'HttpOnly Cookie 不得对脚本可见')
  await secondPage.screenshot({ path: join(screenshotDir, '02-relogin-console.png'), fullPage: true })
  results.push('重新登录进入工作台，document.cookie 读不到登录会话')

  // 6. 账号页：当前设备标记 + 会话列表；撤销第二个浏览器会话后它立即失效。
  await secondPage.goto(base + '/settings', { waitUntil: 'networkidle' })
  await secondPage.getByRole('heading', { name: /登录设备与会话/ }).waitFor({ state: 'visible', timeout: 15000 })
  const list = secondPage.locator('section', { hasText: '登录设备与会话' })
  const rows = list.locator('li')
  await rows.first().waitFor({ state: 'visible', timeout: 10000 })
  const before = await rows.count()
  assert.ok(before >= 2, `应至少有两个登录会话，实际 ${before}`)
  await secondPage.screenshot({ path: join(screenshotDir, '03-account-sessions.png'), fullPage: true })
  const currentRow = list.locator('li', { hasText: '当前设备' })
  assert.equal(await currentRow.count(), 1, '必须且只能标记一个当前设备')
  const otherRow = list.locator('li').filter({ hasNotText: '当前设备' }).first()
  await otherRow.getByRole('button', { name: '撤销' }).click()
  await secondPage.waitForFunction(
    // 会话行的稳定标识是“最近活动”；直接数 li 会被导航项干扰。
    expected => [...document.querySelectorAll('li')].filter(row => row.textContent?.includes('最近活动')).length === expected,
    before - 1,
    { timeout: 15000 },
  )
  assert.equal(await rows.count(), before - 1, `撤销后会话数应从 ${before} 降到 ${before - 1}`)
  results.push(`账号页会话列表 ${before} → ${before - 1}：撤销其他设备后当前设备仍在`)

  // 7. 撤销确实作用于那条会话：另一个浏览器上下文的下一次请求被拒。
  await page.goto(base + '/projects', { waitUntil: 'networkidle' })
  await page.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
  results.push('被撤销的浏览器会话下一次请求即回到登录页（撤销对其他上下文生效）')

  // 8. 刷新保持会话：当前浏览器仍在工作台，不需要重新输入密码。
  await secondPage.reload({ waitUntil: 'networkidle' })
  await secondPage.locator('nav').first().waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await secondPage.locator('#auth-login').count(), 0, '刷新后不应要求重新登录')
  results.push('刷新后仍是登录态（Cookie 会话有效，CSRF 由 /auth/me 重新下发）')

  // 9. 写操作缺少 CSRF 必须被拒绝（防止只靠 Cookie 的跨站写）。
  const csrfRejected = await secondPage.evaluate(async () => {
    const response = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'csrf-probe' }) })
    return response.status
  })
  assert.equal(csrfRejected, 403, `缺少 CSRF 的写请求必须 403，实际 ${csrfRejected}`)
  results.push('同源 Cookie 写请求缺少 X-CSRF-Token 时返回 403')

  // 10. 退出登录后回到登录页，且旧 Cookie 不再可用。
  await secondPage.goto(base + '/settings', { waitUntil: 'networkidle' })
  await secondPage.getByRole('button', { name: '退出登录' }).click()
  await secondPage.locator('#auth-login').waitFor({ state: 'visible', timeout: 15000 })
  const stale = await secondPage.evaluate(async () => (await fetch('/api/auth/me')).status)
  assert.equal(stale, 401, `退出后旧会话必须失效，实际 ${stale}`)
  results.push('退出登录回到登录页，旧会话立即失效（401）')

  // 11. 主机本地恢复：CLI 重置密码后新密码可登录，旧密码不行，且它只在本机可用（无 HTTP 端点）。
  const cli = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('npx', ['tsx', 'src/cli.ts', 'credentials', 'reset-password', '--username', username, '--password', newPassword, '--database', databasePath], { cwd: serverRoot, env: { ...process.env, WEMUX_DATABASE_PATH: databasePath, WEMUX_ADMIN_EMAILS: administratorEmail } })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', rejectPromise)
    child.on('close', code => resolvePromise({ code, stdout, stderr }))
  })
  assert.equal(cli.code, 0, `恢复 CLI 必须成功：${cli.stderr}`)
  assert.ok(!`${cli.stdout}${cli.stderr}`.includes(password), 'CLI 输出不得包含旧密码')
  // 恢复入口只能在本机进程内使用：不存在任何 HTTP 端点（未知 /api 路径先撞鉴权 401，再是 404）。
  const exposed = await fetch(`${base}/api/credentials/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.ok([401, 404].includes(exposed.status), `恢复流程不得暴露可用的 HTTP 端点，实际 ${exposed.status}`)
  await page.goto(base + '/', { waitUntil: 'networkidle' })
  await page.locator('#auth-login').fill(username)
  await page.locator('#auth-password').fill(password)
  await page.getByRole('button', { name: '登录' }).click()
  const staleAlert = page.getByRole('alert')
  await staleAlert.waitFor({ state: 'visible', timeout: 10000 })
  assert.match(await staleAlert.innerText(), /账号或密码不正确/, '重置后旧密码必须失效')
  await page.locator('#auth-password').fill(newPassword)
  await page.getByRole('button', { name: '登录' }).click()
  await page.locator('nav').first().waitFor({ state: 'visible', timeout: 15000 })
  results.push('主机本地 CLI 重置密码：旧密码失效、新密码可登录、无可用 HTTP 端点')

  assert.deepEqual(pageErrors, [], `页面不应出现 JS 错误：${pageErrors.join(' | ')}`)
  await shot('04-final-console')

  const report = { base, databasePath, screenshotDir, results, pageErrors }
  await writeFile(join(workspace, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\n真实浏览器验收通过（Server ${base}，证据 ${workspace}）`)
  for (const line of results) console.log(`- ${line}`)
} finally {
  await context.close().catch(() => {})
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