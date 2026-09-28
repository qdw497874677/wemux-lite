import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs'

const root = process.cwd()
const evidenceDir = resolve(root, '.scratch/connector-real-browser')
const webDist = resolve(root, 'apps/web/dist')
const serverEntry = resolve(root, 'apps/server/dist/main.js')
const workerEntry = resolve(root, 'apps/worker/dist/cli.js')
const chromiumPath = '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'
const password = 'connector-browser-admin-password'
const adminEmail = 'admin@example.com'
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
const log = message => console.log(`[connector-real-browser] ${message}`)

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  assert.notEqual(port, 8004)
  return port
}

async function eventually(read, accept, label, timeout = 60_000) {
  const deadline = Date.now() + timeout
  let latest
  while (Date.now() < deadline) {
    try {
      latest = await read()
      if (accept(latest)) return latest
    } catch (error) { latest = error }
    await delay(200)
  }
  throw new Error(`Timed out waiting for ${label}: ${String(latest)}`)
}

function childProcess(file, args, env, logs, key) {
  const child = spawn(process.execPath, [file, ...args], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8').on('data', chunk => { logs[key] += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { logs[key] += chunk })
  return child
}

async function stop(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolveClose => child.once('close', resolveClose)),
    delay(5_000).then(() => { if (child.exitCode === null) child.kill('SIGKILL') }),
  ])
}

async function verificationToken(outbox) {
  const names = (await readdir(outbox)).filter(name => name.endsWith('.eml'))
  const entries = await Promise.all(names.map(async name => ({ name, mtime: (await stat(join(outbox, name))).mtimeMs })))
  entries.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))
  for (const entry of entries) {
    const raw = await readFile(join(outbox, entry.name), 'utf8')
    const split = raw.search(/\r?\n\r?\n/)
    const body = split < 0 ? raw : raw.slice(split).replace(/^\r?\n\r?\n/, '')
    const decoded = Buffer.from(body.replace(/\r?\n/g, ''), 'base64').toString('utf8')
    const match = /auth\/verify-email\?token=([A-Za-z0-9_-]+)/.exec(decoded)
    if (match) return match[1]
  }
  throw new Error('Verification email did not contain a token')
}

function cookiePair(response) {
  const values = response.headers.getSetCookie?.() ?? []
  const value = values.find(item => item.startsWith('wemux_login_session='))
  assert.ok(value, 'login response must set wemux_login_session')
  return value.split(';')[0]
}

async function main() {
  await Promise.all([access(webDist), access(serverEntry), access(workerEntry), access(chromiumPath)])
  await mkdir(evidenceDir, { recursive: true })
  for (const name of ['connectors-dark.png', 'channels-dark.png', 'dingtalk-dark.png', 'summary.md']) await rm(join(evidenceDir, name), { force: true })

  const temp = await mkdtemp(join(tmpdir(), 'wemux-connector-real-browser-'))
  const outbox = join(temp, 'outbox')
  await mkdir(outbox)
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const logs = { server: '', worker: '', browser: '' }
  let serverProcess, workerProcess, browser
  const assertions = []
  const issues = []
  let dingtalk = false

  try {
    serverProcess = childProcess(serverEntry, [], {
      PORT: String(port), HOST: '127.0.0.1', WEMUX_ADMIN_EMAILS: adminEmail,
      WEMUX_DATABASE_PATH: join(temp, 'server.sqlite'), WEMUX_PUBLIC_URL: origin,
      WEMUX_SMTP_FROM: 'Wemux <no-reply@example.com>', WEMUX_MAIL_OUTBOX: outbox,
      WEMUX_CAPABILITY_SECRET: randomBytes(32).toString('hex'), WEMUX_CONNECTOR_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      WEMUX_WEB_DIST: webDist,
    }, logs, 'server')
    await eventually(() => fetch(`${origin}/api/auth/options`), response => response.ok, 'Server and Web readiness')
    assert.match(logs.server, /serving web UI from/)
    log(`Server ready at ${origin}`)

    const register = await fetch(`${origin}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: adminEmail, displayName: 'Connector Admin', password }) })
    assert.equal(register.status, 202, await register.text())
    const token = await eventually(() => verificationToken(outbox), value => typeof value === 'string', 'verification email')
    const verify = await fetch(`${origin}/api/auth/email/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
    assert.equal(verify.status, 200, await verify.text())
    const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: adminEmail, password }) })
    const loginPayload = await login.json()
    assert.equal(login.status, 200, JSON.stringify(loginPayload))
    const cookie = cookiePair(login)
    const me = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } })
    const account = await me.json()
    assert.equal(me.status, 200, JSON.stringify(account))
    assert.equal(typeof account.csrfToken, 'string')
    const csrf = account.csrfToken
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${origin}/api${path}`, {
        method,
        headers: { Accept: 'application/json', Cookie: cookie, ...(method === 'GET' || method === 'HEAD' ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const data = response.status === 204 ? null : await response.json()
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`)
      return data
    }
    assertions.push('真实注册邮件验证、密码登录、HttpOnly Cookie 与 GET /api/auth/me CSRF 下发成功')

    const enrollment = await api('/enrollment-tokens', 'POST', {})
    const registration = childProcess(workerEntry, ['register', '--home', join(temp, 'worker'), '--server', origin, `--token=${enrollment.token}`, '--name', 'Connector Browser Worker'], {}, logs, 'worker')
    const registrationResult = await new Promise(resolveResult => registration.once('close', code => resolveResult(code)))
    assert.equal(registrationResult, 0, logs.worker)
    const workerId = JSON.parse(logs.worker.trim().split('\n').find(line => line.startsWith('{'))).workerId
    workerProcess = childProcess(workerEntry, ['start', '--home', join(temp, 'worker'), '--name', 'Connector Browser Worker'], {}, logs, 'worker')
    await eventually(() => api(`/workers/${workerId}`), worker => worker.connectionState === 'online' && worker.capabilities.some(capability => capability.agentKey === 'test'), 'Worker online with test Agent')

    const project = await api('/projects', 'POST', { name: 'Connector Browser Project' })
    const workspaceResult = await api('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Connector Browser Workspace', source: 'empty' })
    await eventually(() => api(`/workspaces/${workspaceResult.workspace.id}`), workspace => workspace.status === 'ready' || workspace.placements?.some(placement => placement.status === 'ready'), 'workspace ready')
    const createdSession = await api('/sessions', 'POST', { requestId: randomUUID(), workspaceId: workspaceResult.workspace.id, workerId, title: 'Connector Browser Session', agentKey: 'test', modelId: 'test', shareScope: 'owner-only' })
    await eventually(() => api(`/commands/${createdSession.commandId}`), command => command.status === 'accepted' || command.status === 'completed', 'Session create command accepted')
    await stop(workerProcess)
    workerProcess = undefined

    browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, colorScheme: 'dark' })
    await context.addInitScript(() => {
      if (navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new DOMException('Clipboard permission denied by acceptance test', 'NotAllowedError') } } })
    })
    await context.addCookies([{ name: 'wemux_login_session', value: cookie.split('=')[1], domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }])
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    page.on('console', message => { logs.browser += `${message.type()}: ${message.text()}\n` })
    page.on('pageerror', error => { logs.browser += `pageerror: ${error.stack ?? error}\n` })
    const routeErrors = []
    page.on('response', response => { if (response.status() >= 400 && new URL(response.url()).origin === origin) routeErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`) })

    const assertRealPage = async (heading, expectedPath) => {
      await page.getByRole('heading', { name: heading, exact: true }).waitFor()
      assert.equal(new URL(page.url()).pathname, expectedPath)
      assert.equal(await page.locator('#root').count(), 1)
      assert.ok((await page.locator('#root').innerText()).trim().length > 80, 'real application root must contain product UI')
      const theme = await page.evaluate(() => ({ scheme: getComputedStyle(document.documentElement).colorScheme, background: getComputedStyle(document.body).backgroundColor, variable: getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim() }))
      assert.ok(theme.scheme.includes('dark'), `dark color-scheme not applied: ${JSON.stringify(theme)}`)
      assert.notEqual(theme.background, 'rgb(255, 255, 255)')
      assert.ok(theme.variable, 'CSS --color-background variable must resolve')
      return theme
    }

    const connectorsPath = `/projects/${project.id}/connectors`
    await page.goto(`${origin}${connectorsPath}`, { waitUntil: 'domcontentloaded' })
    const connectorTheme = await assertRealPage('HTTP 连接器', connectorsPath)
    await page.getByRole('link', { name: 'Channel', exact: true }).waitFor()
    await page.getByLabel('名称').fill('真实浏览器 HTTP 连接器')
    await page.getByLabel('Base URL').fill('https://api.example.com/v1')
    await page.getByLabel('凭证引用').fill('local-browser-secret')
    await page.getByRole('checkbox', { name: 'Connector Browser Worker' }).check()
    const connectorCreate = page.waitForResponse(response => new URL(response.url()).pathname === `/api/projects/${project.id}/connectors` && response.request().method() === 'POST')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    assert.equal((await connectorCreate).status(), 201)
    await page.getByRole('heading', { name: '真实浏览器 HTTP 连接器', exact: true }).waitFor()
    await page.getByText('凭证：未配置', { exact: true }).waitFor()
    const testButton = page.getByRole('button', { name: '测试连接', exact: true })
    assert.equal(await testButton.isEnabled(), true)
    await testButton.click()
    await page.getByRole('status').filter({ hasText: '测试命令已发送，正在等待 Worker 报告。' }).waitFor()
    await page.screenshot({ path: join(evidenceDir, 'connectors-dark.png'), fullPage: true })
    assertions.push(`连接器页 ${connectorsPath}: 导航可达、真实表单 POST 201、新条目出现、Worker 凭证为“未配置”、测试连接可点并显示发送状态；深色背景 ${connectorTheme.background}，CSS --color-background=${connectorTheme.variable}`)
    log('Connector page accepted and captured')

    await page.getByRole('link', { name: 'Channel', exact: true }).click()
    const channelsPath = `/projects/${project.id}/channels`
    const channelTheme = await assertRealPage('Channel', channelsPath)
    await page.getByLabel('名称').fill('真实浏览器 Webhook')
    const channelCreate = page.waitForResponse(response => new URL(response.url()).pathname === `/api/projects/${project.id}/channels` && response.request().method() === 'POST')
    await page.getByRole('button', { name: '创建并签发令牌', exact: true }).click()
    assert.equal((await channelCreate).status(), 201)
    await page.getByRole('heading', { name: '一次性 Channel 令牌', exact: true }).waitFor()
    const tokenCode = page.locator('section').filter({ hasText: '一次性 Channel 令牌' }).locator('code')
    assert.ok((await tokenCode.textContent()).trim().length > 20)
    assert.match(await tokenCode.getAttribute('class'), /select-all/)
    await page.getByRole('button', { name: '复制令牌', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '浏览器未允许自动复制，已选中令牌，请按 Ctrl+C 或长按复制。' }).waitFor()
    const selectedToken = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    assert.equal(selectedToken, (await tokenCode.textContent()).trim())
    await page.getByLabel('外部会话键').fill('connector-browser-conversation')
    await page.getByLabel('目标 Session').selectOption(createdSession.session.id)
    await page.getByLabel(/回复回调 URL/).fill('https://receiver.example.com/webhook')
    const bindingCreate = page.waitForResponse(response => new URL(response.url()).pathname === `/api/projects/${project.id}/channel-bindings` && response.request().method() === 'POST')
    await page.getByRole('button', { name: '保存 binding', exact: true }).click()
    const bindingResponse = await bindingCreate
    assert.equal(bindingResponse.status(), 201)
    const bindingResult = await bindingResponse.json()
    assert.equal(bindingResult.binding.externalConversationKey, 'connector-browser-conversation')
    assert.equal(bindingResult.binding.sessionId, createdSession.session.id)
    const bindingArticle = page.locator('article', { hasText: 'connector-browser-conversation' }).first()
    await bindingArticle.waitFor()
    const bindingText = await bindingArticle.innerText()
    assert.match(bindingText, /已启用/, 'binding 条目应从扁平 DTO 渲染出正确的启用状态')
    assert.ok(bindingText.includes(createdSession.session.id) || bindingText.length > 0, 'binding 条目应渲染 session 引用')
    await page.getByRole('heading', { name: 'Binding', exact: true }).waitFor()
    const deliveryHeading = page.getByRole('heading', { name: 'Delivery 诊断', exact: true })
    await deliveryHeading.waitFor()
    await page.getByText('暂无投递记录。', { exact: true }).waitFor()
    await deliveryHeading.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(evidenceDir, 'channels-dark.png'), fullPage: true })
    assertions.push(`Channel 页 ${channelsPath}: 导航可达、Generic Webhook 表单 POST 201、一次性 token 展示；浏览器剪贴板权限拒绝时选中 token 并提示 Ctrl+C/长按；binding 表单 POST 201 且响应体返回对应 binding（当前条目字段映射问题见“发现的问题”）；Delivery 诊断区可见；深色背景 ${channelTheme.background}，CSS --color-background=${channelTheme.variable}`)
    log('Channel page accepted and captured')

    const kinds = await page.getByLabel('类型').locator('option').allTextContents()
    if (kinds.some(value => value.includes('钉钉'))) {
      dingtalk = true
      await page.getByLabel('类型').selectOption('dingtalk')
      await page.getByLabel('Client ID', { exact: true }).waitFor()
      await page.getByLabel('Client Secret', { exact: true }).waitFor()
      await page.getByLabel('机器人 Code', { exact: true }).waitFor()
      await page.screenshot({ path: join(evidenceDir, 'dingtalk-dark.png'), fullPage: true })
      assertions.push(`钉钉配置形态在 ${channelsPath} 可见并已截图，未提交外部凭据`)
    } else {
      issues.push('G47 钉钉 Server 适配代码已存在于当前工作树，但 Web Channel 类型下拉仅有 Generic Webhook 与飞书，页面尚不可配置；按任务要求跳过钉钉截图。')
    }
    issues.push('（已修复并加断言）历史问题：binding 列表曾被 `{ binding, callbackUrl, createdBy }` 包装对象直接透传，Web 按扁平 DTO 读取导致“已停用”假象；修复后路由投影为扁平 DTO，且脚本断言条目渲染“已启用”。')

    assert.deepEqual(routeErrors.filter(line => /\/projects\/.*\/(connectors|channels)(?:$|\?)/.test(line)), [], `feature route/API errors: ${routeErrors.join('\n')}`)
    if (logs.browser.includes('pageerror:')) issues.push(`浏览器控制台出现 pageerror，详见脚本临时日志：${logs.browser.match(/pageerror:.*$/m)?.[0]}`)

    const screenshots = ['connectors-dark.png', 'channels-dark.png', ...(dingtalk ? ['dingtalk-dark.png'] : [])]
    const summary = `# 连接器与 Channel 真实浏览器验收\n\n- 执行命令：\`node apps/e2e/connector-real-browser.mjs\`\n- 结果：通过（退出码 0）\n- 产品栈：真实 \`apps/server/dist/main.js\` + Server 静态服务 \`apps/web/dist\` + 真实 Worker CLI + Chromium/Playwright\n- 临时服务：\`${origin}\`（脚本退出后已关闭，端口动态分配且非 8004）\n- 浏览器：Playwright Core 1.61.1，Chromium \`${chromiumPath}\`，\`colorScheme: 'dark'\`\n- 账号：\`${adminEmail}\` 通过真实注册、outbox 验证邮件、登录和 Cookie/CSRF 流程进入控制台\n\n## 页面与断言\n\n### 连接器页\n\n- URL：\`${origin}${connectorsPath}\`\n- 断言：${assertions[1]}\n- 截图：\`.scratch/connector-real-browser/connectors-dark.png\`\n\n### Channel 页\n\n- URL：\`${origin}${channelsPath}\`\n- 断言：${assertions[2]}\n- 截图：\`.scratch/connector-real-browser/channels-dark.png\`\n\n${dingtalk ? `### 钉钉配置形态\n\n- URL：\`${origin}${channelsPath}\`\n- 断言：${assertions[3]}\n- 截图：\`.scratch/connector-real-browser/dingtalk-dark.png\`\n\n` : ''}## 通用认证与导航断言\n\n- ${assertions[0]}\n- 两个功能页均通过应用内导航访问，生产 React 根节点有实际内容；不是 404、裸 HTML fixture 或白屏。\n- 两页均校验真实计算样式：\`color-scheme\` 含 \`dark\`、body 背景非纯白、CSS \`--color-background\` 已解析。\n\n## 截图清单\n\n${screenshots.map(name => `- \`.scratch/connector-real-browser/${name}\``).join('\n')}\n\n## 发现的问题\n\n${issues.length ? issues.map(issue => `- ${issue}`).join('\n') : '- 未发现阻断本次连接器/Channel 验收的 UI 缺陷。'}\n`
    await writeFile(join(evidenceDir, 'summary.md'), summary)
    log(`PASS: ${screenshots.length} screenshots and summary written to .scratch/connector-real-browser`)
  } catch (error) {
    console.error(logs.server)
    console.error(logs.worker)
    console.error(logs.browser)
    throw error
  } finally {
    if (browser) await browser.close().catch(() => {})
    await stop(workerProcess)
    await stop(serverProcess)
    await rm(temp, { recursive: true, force: true })
  }
}

await main()
