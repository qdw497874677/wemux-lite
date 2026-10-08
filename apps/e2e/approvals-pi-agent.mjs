import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs'

const root = process.cwd()
const evidenceDir = resolve(root, process.env.WEMUX_G44B_EVIDENCE_DIR ?? '.scratch/g44b-real')
const blockedDir = resolve(root, process.env.WEMUX_G44B_BLOCKED_DIR ?? '.scratch/feature-suite-b1/pi-agent-e2e')
const chromiumPath = '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'
const piPath = '/opt/data/.npm-global/bin/pi'
const requestedModel = process.env.WEMUX_REAL_PI_MODEL ?? 'my-codex/gpt-5.6-sol'
const requireReal = process.env.WEMUX_REAL_AGENT_E2E === '1'
const adminEmail = 'g44b-admin@example.com'
const password = 'g44b-real-pi-password'
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))

function privateFixtureHost() {
  if (process.env.WEMUX_G44B_FIXTURE_HOST) return process.env.WEMUX_G44B_FIXTURE_HOST
  for (const addresses of Object.values(networkInterfaces())) {
    const address = addresses?.find(item => item.family === 'IPv4' && !item.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address))
    if (address) return address.address
  }
  throw new Error('未找到可供 Worker HTTP Connector 访问的私网 fixture 地址，请设置 WEMUX_G44B_FIXTURE_HOST')
}
const log = message => console.log(`[approvals-pi-agent] ${message}`)

async function freePort() {
  const server = createNetServer()
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  assert.notEqual(address.port, 8004)
  return address.port
}

async function eventually(read, accept, label, timeout = 120_000) {
  const deadline = Date.now() + timeout
  let latest
  while (Date.now() < deadline) {
    try { latest = await read(); if (accept(latest)) return latest } catch (error) { latest = error }
    await delay(250)
  }
  throw new Error(`等待 ${label} 超时: ${latest instanceof Error ? latest.stack : JSON.stringify(latest)}`)
}

function child(file, args, env, logs, key) {
  const processChild = spawn(process.execPath, [file, ...args], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  processChild.stdout.setEncoding('utf8').on('data', chunk => { logs[key] += chunk })
  processChild.stderr.setEncoding('utf8').on('data', chunk => { logs[key] += chunk })
  return processChild
}

async function stop(processChild) {
  if (!processChild || processChild.exitCode !== null) return
  processChild.kill('SIGTERM')
  await Promise.race([new Promise(resolveClose => processChild.once('close', resolveClose)), delay(5_000).then(() => processChild.exitCode === null && processChild.kill('SIGKILL'))])
}

async function piPreflight() {
  await access(piPath)
  const result = await new Promise(resolveResult => {
    const processChild = spawn(piPath, ['--mode', 'rpc', '--no-session'], { cwd: root, env: { ...process.env, HOME: '/opt/data' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    processChild.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; if (stdout.includes('"command":"get_available_models"')) processChild.kill('SIGTERM') })
    processChild.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    processChild.once('close', code => resolveResult({ code, stdout, stderr }))
    processChild.stdin.end('{"type":"get_available_models","id":"models"}\n')
    setTimeout(() => processChild.kill('SIGKILL'), 20_000).unref()
  })
  const line = result.stdout.split('\n').find(value => value.includes('"command":"get_available_models"'))
  assert.ok(line, `Pi 模型探针无响应: ${result.stderr}`)
  const models = JSON.parse(line).data.models
  const slash = requestedModel.indexOf('/')
  const provider = requestedModel.slice(0, slash), modelId = requestedModel.slice(slash + 1)
  assert.ok(models.some(model => model.provider === provider && model.id === modelId), `${requestedModel} 不可用`)
  return models
}

async function integrationBlockers() {
  const [tools, runtime, capabilityService, connectorService] = await Promise.all([
    readFile(resolve(root, 'apps/worker/src/capabilities/pi-tools.ts'), 'utf8'),
    readFile(resolve(root, 'apps/worker/src/connectors/runtime.ts'), 'utf8'),
    readFile(resolve(root, 'apps/server/src/application/capability-service.ts'), 'utf8'),
    readFile(resolve(root, 'apps/server/src/application/connector-service.ts'), 'utf8'),
  ])
  const blockers = []
  if (!tools.includes("['http_call'")) blockers.push('Pi capability extension 未注册 http_call。')
  if (/filter\(definition => definition\.kind === 'mcp'/.test(runtime)) blockers.push('turn snapshot 仍只纳入 MCP Connector。')
  if (/allowedConnectorIds: \[\]/.test(capabilityService)) blockers.push('Server capability grant 仍固定签发 allowedConnectorIds: []。')
  if (!connectorService.includes("v.kind !== 'http' && v.kind !== 'mcp'")) blockers.push('ConnectorService 仍拒绝 MCP kind。')
  if (!runtime.includes("operation === 'http.call'")) blockers.push('Worker capability runtime 未将 http.call 路由到 ToolExecutionGateway。')
  return blockers
}

async function verificationToken(outbox) {
  const names = (await readdir(outbox)).filter(name => name.endsWith('.eml'))
  const entries = await Promise.all(names.map(async name => ({ name, mtime: (await stat(join(outbox, name))).mtimeMs })))
  entries.sort((a, b) => b.mtime - a.mtime)
  for (const entry of entries) {
    const raw = await readFile(join(outbox, entry.name), 'utf8')
    const body = raw.slice(Math.max(0, raw.search(/\r?\n\r?\n/))).replace(/^\r?\n\r?\n/, '')
    const decoded = Buffer.from(body.replace(/\r?\n/g, ''), 'base64').toString('utf8')
    const match = /auth\/verify-email\?token=([A-Za-z0-9_-]+)/.exec(decoded)
    if (match) return match[1]
  }
  throw new Error('验证邮件没有 token')
}

function cookiePair(response) {
  const value = (response.headers.getSetCookie?.() ?? []).find(item => item.startsWith('wemux_login_session='))
  assert.ok(value, '登录响应没有 wemux_login_session')
  return value.split(';')[0]
}

async function realChain(piModels) {
  const temp = await mkdtemp(join(tmpdir(), 'wemux-g44b-'))
  const outbox = join(temp, 'outbox'), workerHome = join(temp, 'worker')
  await mkdir(outbox)
  const serverPort = await freePort(), fixturePort = await freePort()
  const origin = `http://127.0.0.1:${serverPort}`
  const fixtureHost = privateFixtureHost()
  const fixtureOrigin = `http://${fixtureHost}:${fixturePort}`
  const logs = { server: '', worker: '' }, requests = []
  const fixture = createHttpServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : null })
    await writeFile(join(temp, 'fixture-requests.json'), JSON.stringify(requests))
    if (process.env.WEMUX_G44B_FAIL_IN_NEXT === '1') {
      response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'fixture_down' }))
    } else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: true, fixture: 'g44b' }))
  })
  await new Promise((resolveListen, reject) => {
    const onError = error => { fixture.off('listening', onListen); reject(error) }
    const onListen = () => { fixture.off('error', onError); resolveListen() }
    fixture.once('error', onError).once('listening', onListen).listen(fixturePort, fixtureHost === '127.0.0.1' ? fixtureHost : '0.0.0.0')
  })
  let serverProcess, workerProcess, browser
  try {
    serverProcess = child(resolve(root, 'apps/server/dist/main.js'), [], { PORT: String(serverPort), HOST: '127.0.0.1', WEMUX_ADMIN_EMAILS: adminEmail, WEMUX_DATABASE_PATH: join(temp, 'server.sqlite'), WEMUX_PUBLIC_URL: origin, WEMUX_SMTP_FROM: 'Wemux <no-reply@example.com>', WEMUX_MAIL_OUTBOX: outbox, WEMUX_CAPABILITY_SECRET: randomBytes(32).toString('hex'), WEMUX_CONNECTOR_ENCRYPTION_KEY: randomBytes(32).toString('hex'), WEMUX_WEB_DIST: resolve(root, 'apps/web/dist'), ...(process.env.WEMUX_G44B_NEXT_DIST ? { WEMUX_WEB_NEXT_DIST: process.env.WEMUX_G44B_NEXT_DIST } : {}) }, logs, 'server')
    await eventually(() => fetch(`${origin}/api/auth/options`), response => response.ok, 'Server 启动', 30_000)
    let response = await fetch(`${origin}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: adminEmail, displayName: 'G44b Admin', password }) })
    assert.equal(response.status, 202, await response.text())
    response = await fetch(`${origin}/api/auth/email/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await eventually(() => verificationToken(outbox), Boolean, '验证邮件', 30_000) }) })
    assert.equal(response.status, 200, await response.text())
    response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: adminEmail, password }) })
    const cookie = cookiePair(response)
    const me = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } }).then(value => value.json())
    const api = async (path, method = 'GET', body) => {
      const result = await fetch(`${origin}/api${path}`, { method, headers: { Accept: 'application/json', Cookie: cookie, ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const data = result.status === 204 ? null : await result.json()
      assert.ok(result.ok, `${method} ${path}: ${result.status} ${JSON.stringify(data)}`)
      return data
    }

    const enrollment = await api('/enrollment-tokens', 'POST', {})
    const registration = child(resolve(root, 'apps/worker/dist/cli.js'), ['register', '--home', workerHome, '--server', origin, `--token=${enrollment.token}`, '--name', 'G44b Pi Worker'], {}, logs, 'worker')
    assert.equal(await new Promise(resolveClose => registration.once('close', resolveClose)), 0, logs.worker)
    const workerId = JSON.parse(logs.worker.trim().split('\n').find(line => line.startsWith('{'))).workerId
    logs.worker = ''
    workerProcess = child(resolve(root, 'apps/worker/dist/cli.js'), ['start', '--home', workerHome, '--name', 'G44b Pi Worker'], { HOME: '/opt/data', PATH: `/opt/data/.npm-global/bin:${process.env.PATH ?? ''}`, WEMUX_CONNECTOR_ALLOW_PRIVATE_NETWORK: 'true' }, logs, 'worker')
    await eventually(() => api('/workers'), value => value.items?.some(worker => worker.id === workerId && worker.connectionState === 'online'), 'Worker online', 60_000)
    const capabilityPage = await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities?.some(capability => capability.agentKey === 'pi' && capability.availability.status === 'available'), 'Pi capability', 60_000)
    const pi = capabilityPage.capabilities.find(capability => capability.agentKey === 'pi')
    const platformModelId = requestedModel.replace('/', '::')
    const selectedModel = pi.models.find(model => model.modelId === platformModelId)
    assert.ok(selectedModel, `Worker 未发现模型 ${requestedModel}; Pi 探针模型数 ${piModels.length}`)

    const project = await api('/projects', 'POST', { name: 'G44b real Pi approval' })
    const workspaceResult = await api('/workspaces', 'POST', { projectId: project.id, workerId, name: 'G44b Workspace', source: 'empty' })
    await eventually(() => api(`/workspaces/${workspaceResult.workspace.id}`), value => value.status === 'ready' || value.placements?.some(item => item.status === 'ready'), 'Workspace ready')
    const connectorResult = await api(`/projects/${project.id}/connectors`, 'POST', { requestId: randomUUID(), definition: { kind: 'http', name: 'G44b Fixture', description: '真实 Pi 审批 fixture', enabled: true, allowedWorkerIds: [workerId], credentialRef: null, riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: false }, config: { baseUrl: `${fixtureOrigin}/`, authentication: 'none', publicHeaders: {}, allowedOperations: [{ id: 'createItem', description: '创建 fixture item', method: 'POST', pathTemplate: '/items', allowedQueryNames: [], allowedRequestHeaderNames: [], requestContentTypes: ['application/json'], operationTypeOverride: 'write' }], allowPrivateNetwork: true } } })
    const connector = connectorResult.definition
    assert.equal(connectorResult.commandIds.length, 1, 'Connector 创建必须分发到目标 Worker')
    await eventually(() => api(`/commands/${connectorResult.commandIds[0]}`), value => value.status === 'accepted' || value.status === 'completed', 'Connector 分发接收')
    await eventually(() => api(`/projects/${project.id}/connectors`), value => value.items.some(item => item.id === connector.id && item.revision === connector.revision), 'Connector 可见')
    const task = await api(`/projects/${project.id}/tasks`, 'POST', { title: 'G44b 原生 Agent 会话', requestId: randomUUID() })
    const fullUiJourney = process.env.WEMUX_G44B_FULL_UI_JOURNEY === '1'
    let created, page
    const pageErrors = []
    if (fullUiJourney) {
      assert.ok(process.env.WEMUX_G44B_NEXT_DIST && process.env.WEMUX_G44B_APPROVE_IN_NEXT === '1' && process.env.WEMUX_G44B_NEXT_MODEL, 'full UI journey requires Next approval and second model')
      browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
      const viewport = process.env.WEMUX_G44B_VIEWPORT === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 960 }
      const context = await browser.newContext({ viewport, colorScheme: 'dark' })
      await context.addCookies([{ name: 'wemux_login_session', value: cookie.split('=')[1], domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }])
      page = await context.newPage()
      page.on('pageerror', error => pageErrors.push(String(error)))
      await page.goto(`${origin}/next/projects/${project.id}?task=${task.id}`)
      const taskSessions = page.getByRole('region', { name: '任务会话', exact: true })
      const environment = taskSessions.getByLabel('会话执行环境', { exact: true })
      const selection = JSON.stringify([workspaceResult.workspace.id, workerId, 'pi', selectedModel.modelId])
      await eventually(() => environment.locator('option').evaluateAll(options => options.map(option => option.value)), values => values.includes(selection), 'Next Task Pi execution environment', 60_000)
      await environment.selectOption(selection)
      await taskSessions.getByLabel('会话标题', { exact: true }).fill('G44b Real Pi')
      const createResponse = page.waitForResponse(result => result.request().method() === 'POST' && new URL(result.url()).pathname === `/api/projects/${project.id}/tasks/${task.id}/sessions`)
      await taskSessions.getByRole('button', { name: '创建任务会话', exact: true }).click()
      const received = await createResponse
      assert.equal(received.status(), 201, 'Next Task UI must create real Pi Session')
      created = await received.json()
    } else created = await api(`/projects/${project.id}/tasks/${task.id}/sessions`, 'POST', { requestId: randomUUID(), workspaceId: workspaceResult.workspace.id, workerId, title: 'G44b Real Pi', agentKey: 'pi', modelId: selectedModel.modelId })
    assert.equal(created.session.taskId, task.id, 'native Pi Session must bind the explicitly chosen Task')
    await eventually(() => api(`/commands/${created.commandId}`), value => value.status === 'accepted' || value.status === 'completed', 'Session 创建')
    assert.ok((await api(`/projects/${project.id}/tasks/${task.id}/sessions`)).items.some(item => item.id === created.session.id), 'non-Run Task Session appears in task-associated discovery')
    const requestId = randomUUID(), toolCallId = randomUUID()
    const prompt = `只调用一次 http_call，不要调用其他工具。参数必须是 connectorId=${connector.id}, connectorRevision=${connector.revision}, operationId=createItem, requestId=${requestId}, toolCallId=${toolCallId}, input={"body":{"source":"real-pi","title":"approval fixture"}}。审批后等待工具结果，然后用一句中文确认完成。`
    let message
    if (fullUiJourney) {
      const taskSessions = page.getByRole('region', { name: '任务会话', exact: true })
      await eventually(() => taskSessions.locator(`li[data-session-id="${created.session.id}"]`).count(), count => count === 1, 'Task UI Session discovery', 30_000)
      await taskSessions.getByRole('button', { name: '查看会话：G44b Real Pi', exact: true }).click()
      const composer = page.getByRole('region', { name: '消息提交' })
      await composer.getByLabel('新消息草稿', { exact: true }).fill(prompt)
      const sendResponse = page.waitForResponse(result => result.request().method() === 'POST' && new URL(result.url()).pathname === `/api/sessions/${created.session.id}/messages`)
      await composer.getByRole('button', { name: '发送新消息', exact: true }).click()
      const received = await sendResponse
      assert.equal(received.status(), 202, 'Next Task UI must send first real Pi prompt')
      message = await received.json()
    } else message = await api(`/sessions/${created.session.id}/messages`, 'POST', { content: prompt })
    await eventually(() => api(`/commands/${message.commandId}`), value => value.status === 'accepted' || value.status === 'completed', '消息接收')
    const pendingPage = await eventually(() => api(`/approvals?projectId=${project.id}&status=pending`), value => value.items?.some(item => item.source?.kind === 'session_tool' && item.source.sessionId === created.session.id), 'HTTP Connector pending approval', 180_000)
    const pending = pendingPage.items.find(item => item.source?.kind === 'session_tool' && item.source.sessionId === created.session.id)

    if (!browser) {
      browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
      const context = await browser.newContext({ viewport: process.env.WEMUX_G44B_VIEWPORT === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 960 }, colorScheme: 'dark' })
      await context.addCookies([{ name: 'wemux_login_session', value: cookie.split('=')[1], domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }])
      page = await context.newPage()
      page.on('pageerror', error => pageErrors.push(String(error)))
    }
    const viewport = page.viewportSize()
    const nextApproval = !!process.env.WEMUX_G44B_NEXT_DIST && process.env.WEMUX_G44B_APPROVE_IN_NEXT === '1'
    const deny = process.env.WEMUX_G44B_DENY_IN_NEXT === '1'
    const cancel = process.env.WEMUX_G44B_STOP_IN_NEXT === '1'
    const timeout = process.env.WEMUX_G44B_TIMEOUT_IN_NEXT === '1'
    const fail = process.env.WEMUX_G44B_FAIL_IN_NEXT === '1'
    assert.ok([deny, cancel, timeout, fail].filter(Boolean).length < 2, 'negative paths are separate cases')
    assert.ok(!deny && !cancel && !timeout && !fail || nextApproval, 'negative paths must use Next')
    assert.ok(!deny && !cancel && !timeout && !fail || !process.env.WEMUX_G44B_NEXT_MODEL, 'negative paths and model selection are separate cases')
    if (nextApproval) {
      await page.goto(`${origin}/next/projects/${project.id}?task=${created.session.taskId}&session=${created.session.id}`)
      const controls = page.getByRole('region', { name: '队列与 Turn 控制' })
      const action = cancel ? controls.getByRole('button', { name: /^停止当前 Turn / }) : controls.getByRole('button', { name: deny ? '拒绝操作' : '批准操作', exact: true })
      await action.waitFor({ state: 'visible' })
      await page.screenshot({ path: join(evidenceDir, '01-real-pi-http-call-pending.png'), fullPage: true })
      if (!timeout) await action.click()
    } else {
      await page.goto(`${origin}/approvals`)
      await page.getByText(pending.title, { exact: true }).waitFor()
      await page.screenshot({ path: join(evidenceDir, '01-real-pi-http-call-pending.png'), fullPage: true })
      await page.getByText(pending.title, { exact: true }).click()
      await page.getByRole('button', { name: '批准', exact: true }).click()
    }
    const events = await eventually(() => api(`/sessions/${created.session.id}/events?fromSeq=1&limit=1000`), value => value.events?.some(event => event.payload.kind === 'turn.finished' && (cancel || event.payload.outcome === 'completed')) && (deny || cancel || timeout ? requests.length === 0 : requests.length === 1), 'Pi 恢复、fixture 请求与 turn 完成', timeout ? 390_000 : 90_000)
    const terminalTurn = events.events.find(event => event.payload.kind === 'turn.finished')
    if (!cancel) assert.equal(terminalTurn?.payload.outcome, 'completed', 'approval/denial/timeout must finish the native Pi Turn')
    const usageEvents = events.events.filter(event => event.payload.kind === 'usage.updated' && event.payload.usage?.source === 'runtime')
    assert.ok(usageEvents.some(event => event.payload.usage.scope === 'operation' && event.payload.usage.inputTokens > 0 && event.payload.usage.outputTokens > 0 && event.payload.usage.totalTokens >= event.payload.usage.inputTokens + event.payload.usage.outputTokens), 'native Pi must persist nonzero finalized Runtime usage in Journal')
    await writeFile(join(evidenceDir, 'usage-events.json'), JSON.stringify({ count: usageEvents.length, samples: usageEvents.map(event => ({ seq: event.seq, turnId: event.payload.turnId, scope: event.payload.usage.scope, inputTokens: event.payload.usage.inputTokens, outputTokens: event.payload.usage.outputTokens, totalTokens: event.payload.usage.totalTokens })) }, null, 2))
    if (timeout) {
      const expired = events.events.find(event => event.payload.kind === 'approval.expired' && event.payload.approvalId === toolCallId)
      const finished = events.events.find(event => event.payload.kind === 'turn.finished')
      assert.equal(expired?.payload.reason, 'timeout', 'real pending approval must expire by its own timer')
      assert.equal(finished?.payload.outcome, 'completed', 'Pi must receive timed-out tool result and complete Turn')
      const requested = events.events.find(event => event.payload.kind === 'approval.requested' && event.payload.approvalId === toolCallId)
      assert.ok(Date.parse(expired.occurredAt) - Date.parse(requested?.occurredAt) >= 295_000, 'native approval must remain pending for five minutes')
      const invocation = events.events.find(event => event.payload.kind === 'tool.started' && event.payload.toolName === 'http_call' && event.payload.input?.toolCallId === toolCallId)
      assert.ok(invocation, 'timed-out approval maps to native Pi http_call invocation')
      const output = events.events.filter(event => event.payload.kind === 'tool.output.delta' && event.payload.toolCallId === invocation.payload.toolCallId)
      const terminal = events.events.find(event => event.payload.kind === 'tool.finished' && event.payload.toolCallId === invocation.payload.toolCallId)
      const text = output.map(event => event.payload.text).join('')
      const elapsedMs = Date.parse(expired.occurredAt) - Date.parse(requested.occurredAt)
      await writeFile(join(evidenceDir, 'timeout-events.json'), JSON.stringify({ reason: expired.payload.reason, elapsedMs, nativeToolCallId: invocation.payload.toolCallId, startedSeq: invocation.seq, expiredSeq: expired.seq, toolOutputSeqs: output.map(event => event.seq), toolOutputMatched: /approval_denied: Connector call was denied/.test(text), toolOutputFailureCodes: [...new Set(text.match(/\b(?:approval_denied|AbortError|TimeoutError|UND_ERR_HEADERS_TIMEOUT|ECONNRESET)\b/g) ?? [])], toolFinishedSeq: terminal?.seq ?? null, exitCode: terminal?.payload.exitCode ?? null, turnFinishedSeq: finished.seq, turnOutcome: finished.payload.outcome, nativeSequence: events.events.filter(event => ['tool.started', 'tool.output.delta', 'tool.finished', 'turn.finished', 'approval.expired'].includes(event.payload.kind)).map(event => ({ seq: event.seq, kind: event.payload.kind, toolCallId: event.payload.toolCallId ?? null, exitCode: event.payload.kind === 'tool.finished' ? event.payload.exitCode : undefined })) }, null, 2))
      assert.match(text, /approval_denied: Connector call was denied/, 'Pi must receive the terminal Connector denial, not a transport error')
      assert.equal(terminal?.payload.exitCode, 1, 'timed-out connector ends with failed native tool')
      assert.ok(expired.seq < terminal.seq && terminal.seq < finished.seq, 'timeout precedes native tool result, which precedes Turn completion')
      assert.ok([invocation, ...output, terminal, finished].every(event => event.payload.turnId === requested.payload.turnId), 'all terminal events belong to the same Turn')

    }
    if (cancel) {
      const finished = events.events.find(event => event.payload.kind === 'turn.finished')
      assert.equal(finished.payload.outcome, 'cancelled', 'explicit stop must not turn native abort into provider failure')
      assert.ok(events.events.some(event => event.payload.kind === 'session.runtime.changed' && event.payload.state === 'stopping'))
    }
    if (!deny && !cancel && !timeout) {
      assert.equal(requests[0].method, 'POST')
      assert.equal(requests[0].url, '/items')
      assert.deepEqual(requests[0].body, { source: 'real-pi', title: 'approval fixture' })
    } else assert.equal(requests.length, 0, 'denied, cancelled or timed out connector cannot write fixture')
    assert.ok(events.events.some(event => event.payload.kind === 'approval.requested' && event.payload.approvalId === toolCallId))
    if (cancel || timeout) {
      assert.ok(events.events.some(event => event.payload.kind === 'approval.expired' && event.payload.approvalId === toolCallId && event.payload.reason === (timeout ? 'timeout' : 'turn_released')), 'negative path expires approval without a human decision')
      assert.equal(events.events.some(event => event.payload.kind === 'approval.resolved' && event.payload.approvalId === toolCallId), false)
    } else assert.ok(events.events.some(event => event.payload.kind === 'approval.resolved' && event.payload.approvalId === toolCallId && event.payload.decision === (deny ? 'deny' : 'approve')))
    if (fail) {
      const invocation = events.events.find(event => event.payload.kind === 'tool.started' && event.payload.toolName === 'http_call' && event.payload.input?.toolCallId === toolCallId)
      assert.ok(invocation, 'fixture 503 must originate from the expected native Pi tool')
      const terminal = events.events.find(event => event.payload.kind === 'tool.finished' && event.payload.toolCallId === invocation.payload.toolCallId)
      const output = events.events.filter(event => event.payload.kind === 'tool.output.delta' && event.payload.toolCallId === invocation.payload.toolCallId)
      const combined = output.map(event => event.payload.text).join('')
      // Pi turns thrown Connector failures into tool-error text, not a JSON
      // result. Require the full structured code/message pair in the matched
      // native invocation, not a coincidental `503` in request metadata.
      const upstreamError = /^upstream_error: Connector upstream returned an error$/.test(combined.trim())
      await writeFile(join(evidenceDir, 'failure-events.json'), JSON.stringify({ upstreamFixtureStatus: requests.length === 1 ? 503 : null, connectorErrorCodeMatched: upstreamError, nativeToolCallId: invocation.payload.toolCallId, outputSeqs: output.map(event => event.seq), toolExitCode: terminal?.payload.exitCode ?? null, turnOutcome: terminalTurn.payload.outcome }, null, 2))
      assert.equal(upstreamError, true, 'native Pi must receive the exact Connector upstream_error without request metadata')
      assert.equal(terminal?.payload.exitCode, 1, 'failed Connector execution must fail the native Pi tool')
      assert.ok(terminal.seq < terminalTurn.seq, 'tool failure precedes completed Turn')
      assert.ok([invocation, ...output, terminal].every(event => event.payload.turnId === terminalTurn.payload.turnId))
    }
    if (deny) {
      const invocation = events.events.find(event => event.payload.kind === 'tool.started' && event.payload.toolName === 'http_call' && event.payload.input?.toolCallId === toolCallId)
      assert.ok(invocation, 'connector approval ID must map to the native Pi http_call invocation')
      const terminal = events.events.filter(event => event.payload.kind === 'tool.finished').map(event => ({ seq: event.seq, kind: event.payload.kind, toolCallId: event.payload.toolCallId, exitCode: event.payload.exitCode }))
      await writeFile(join(evidenceDir, 'denial-events.json'), JSON.stringify({ decision: 'deny', nativeToolCallId: invocation.payload.toolCallId, finished: terminal, turnOutcomes: events.events.filter(event => event.payload.kind === 'turn.finished').map(event => event.payload.outcome) }, null, 2))
      assert.ok(terminal.some(event => event.toolCallId === invocation.payload.toolCallId && event.exitCode === 1), 'denied http_call must finish with exitCode 1')
    }
    await eventually(() => api(`/approvals?projectId=${project.id}&status=${cancel || timeout ? 'expired' : deny ? 'denied' : 'approved'}`), value => value.items?.some(item => item.projectionKey === pending.projectionKey && item.status === (cancel || timeout ? 'expired' : deny ? 'denied' : 'approved')), '审批投影终态')
    if (!nextApproval) {
      await page.reload()
      // The legacy list defaults to pending-only; select approved after refresh.
      await page.getByRole('combobox', { name: '筛选状态' }).click()
      await page.getByRole('option', { name: '已批准' }).click()
      await page.getByText(pending.title, { exact: true }).waitFor()
      await page.getByText('已批准', { exact: true }).first().waitFor()
    } else {
      await page.reload()
      await page.getByRole('region', { name: '会话对话' }).getByText(cancel || timeout ? '审批已失效' : deny ? '已拒绝' : '已批准', { exact: false }).first().waitFor()
    }
    await page.screenshot({ path: join(evidenceDir, '02-real-pi-http-call-approved.png'), fullPage: true })
    await page.goto(`${origin}/timeline`)
    await page.getByRole('heading', { name: '时间线' }).waitFor()
    await page.screenshot({ path: join(evidenceDir, '03-real-pi-timeline.png'), fullPage: true })
    if (process.env.WEMUX_G44B_NEXT_DIST) {
      await page.goto(`${origin}/next/projects/${project.id}?task=${created.session.taskId}&session=${created.session.id}`)
      await page.getByRole('region', { name: '会话对话' }).waitFor()
      await page.getByText('已验证 Journal 历史', { exact: true }).waitFor()
      await page.getByText(cancel || timeout ? '审批已失效' : deny ? '已拒绝' : '已批准', { exact: false }).first().waitFor()
      const usage = page.getByRole('region', { name: '会话历史' }).locator(usageEvents.map(event => `li[data-journal-seq="${event.seq}"]`).join(', '))
      await usage.first().getByRole('heading', { name: '用量记录' }).waitFor()
      assert.match((await usage.allTextContents()).join(''), /输入 Token.*\d+/)
      await page.screenshot({ path: join(evidenceDir, '04-next-real-pi-approved.png'), fullPage: true })
      if (process.env.WEMUX_G44B_NEXT_MODEL) {
        assert.ok(nextApproval, 'Next model selection requires Next approval mode')
        const nextModel = process.env.WEMUX_G44B_NEXT_MODEL.replace('/', '::')
        assert.notEqual(nextModel, selectedModel.modelId)
        assert.ok(pi.modelSwap && pi.models.some(model => model.modelId === nextModel), 'second model must be advertised as switchable')
        const controls = page.getByRole('region', { name: '队列与 Turn 控制' })
        const model = controls.getByRole('region', { name: '模型选择' })
        const retry = controls.getByRole('button', { name: '重试原控制请求' })
        if (await retry.count()) {
          // Reload does not trust a previously admitted decision; explicitly
          // revalidate the same command/Turn before issuing a different control.
          await retry.click()
          await controls.getByText('控制请求已接收。', { exact: false }).waitFor()
        }
        await model.getByRole('combobox', { name: '选择后续模型' }).selectOption(nextModel)
        await model.getByRole('button', { name: '应用到后续 Turn' }).click()
        await eventually(() => api(`/sessions/${created.session.id}/events?fromSeq=1&limit=1000`),
          value => value.events.some(event => event.payload.kind === 'model.changed' && event.payload.modelId === nextModel), '真实 Worker 模型切换')
        await page.reload()
        await model.getByText(`已确认选择：${nextModel}。`, { exact: false }).waitFor()
        const composer = page.getByRole('region', { name: '消息提交' })
        await composer.getByLabel('新消息草稿', { exact: true }).fill('只回复 WEMUX_G44B_MODEL_SWITCH_OK，不要调用工具。')
        await composer.getByRole('button', { name: '发送新消息', exact: true }).click()
        const afterSwitch = await eventually(() => api(`/sessions/${created.session.id}/events?fromSeq=1&limit=1000`),
          value => value.events.filter(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed').length >= 2, '切模型后的 Pi 第二轮', 180_000)
        assert.deepEqual(afterSwitch.events.filter(event => event.payload.kind === 'turn.started').map(event => event.payload.modelId), [selectedModel.modelId, nextModel])
        const turns = afterSwitch.events.filter(event => event.payload.kind === 'turn.started')
        const assistantEvents = afterSwitch.events.filter(event => event.payload.kind === 'assistant.text.delta' && event.payload.turnId === turns[1].payload.turnId)
        assert.ok(assistantEvents.length, 'second Turn has assistant Journal deltas')
        assert.match(assistantEvents.map(event => event.payload.text).join(''), /WEMUX_G44B_MODEL_SWITCH_OK/)
        assert.equal(afterSwitch.events.filter(event => event.payload.kind === 'model.changed' && event.payload.modelId === nextModel).length, 1)
        assert.equal((await api(`/sessions/${created.session.id}`)).binding.modelId, nextModel)
        assert.equal(requests.length, 1, 'second Turn must not repeat approved connector write')
        await page.reload()
        const history = page.getByRole('region', { name: '会话历史' })
        const assistant = history.locator(assistantEvents.map(event => `li[data-journal-seq="${event.seq}"]`).join(', '))
        await assistant.first().getByRole('heading', { name: '助手', exact: true }).waitFor()
        await eventually(() => assistant.allTextContents(), contents => contents.join('').includes('WEMUX_G44B_MODEL_SWITCH_OK'), 'assistant deltas restored after reload')
        // Negative control: user prompt remains visible while the exact assistant
        // Journal entries are removed. The selector must not match that prompt.
        await assistant.evaluateAll(elements => elements.forEach(element => element.remove()))
        assert.equal(await assistant.count(), 0, 'assistant-specific selector must not match the user prompt')
        await history.getByRole('heading', { name: '用户消息' }).last().waitFor()
        await page.reload()
        await assistant.first().getByRole('heading', { name: '助手', exact: true }).waitFor()
        await eventually(() => assistant.allTextContents(), contents => contents.join('').includes('WEMUX_G44B_MODEL_SWITCH_OK'), 'assistant deltas recovered after negative control')
        await page.screenshot({ path: join(evidenceDir, '05-next-real-pi-model-switched.png'), fullPage: true })
      }
    }
    assert.deepEqual(pageErrors, [], 'browser pageerror must stay empty throughout the full journey')
    await writeFile(join(evidenceDir, 'summary.md'), `# G44b 真实 Pi HTTP Connector 审批验收\n\n- 结果：通过；视口：${viewport.width}×${viewport.height}\n- Pi 模型：\`${requestedModel}\`\n- 后续模型：${process.env.WEMUX_G44B_NEXT_MODEL ?? '未测试'}\n- 浏览器决定入口：${nextApproval ? 'Next' : 'Legacy'}；Task UI 创建并首发：${fullUiJourney ? '是' : '否'}；未捕获页面错误：${pageErrors.length}\n- Worker：\`${workerId}\`\n- Task：\`${task.id}\`；Session：\`${created.session.id}\`（显式 Task 创建，不经 Run）\n- Connector：\`${connector.id}\` revision ${connector.revision}\n- Approval：\`${pending.projectionKey}\`\n- fixture：收到 ${requests.length} 次 \`POST /items\`，预期 HTTP 状态 ${fail ? 503 : 200}（拒绝/超时/停止则无调用），请求体为 \`${JSON.stringify(requests[0]?.body ?? null)}\`\n- Journal：包含 \`approval.requested\`、\`${cancel || timeout ? `approval.expired(${timeout ? 'timeout' : 'turn_released'})` : `approval.resolved(${deny ? 'deny' : 'approve'})`}\`、\`turn.finished(${cancel ? 'cancelled' : 'completed'})\`\n- 截图：当前证据目录的 01～04，启用后续模型时还包含 05。\n`)
    await rm(join(blockedDir, 'BLOCKED.md'), { force: true })
    log(fail ? 'REAL PASS: Pi → http_call → approve → fixture 503 → upstream_error → failed native tool → turn completed' : timeout ? 'REAL PASS: Pi → http_call → pending five minutes → timeout → no fixture write → turn completed' : cancel ? 'REAL PASS: Pi → http_call → pending → stop Turn → approval expired → no fixture write → turn cancelled' : deny ? 'REAL PASS: Pi → http_call → pending → deny → no fixture write → failed tool → turn finished' : 'REAL PASS: Pi → http_call → pending → approve → fixture → turn completed')
  } catch (error) {
    await writeFile(join(evidenceDir, 'failed-server.log'), logs.server)
    await writeFile(join(evidenceDir, 'failed-worker.log'), logs.worker)
    try {
      const { DatabaseSync } = await import('node:sqlite').then(m => m)
      const dump = new DatabaseSync(join(workerHome, 'worker.sqlite'), { readOnly: true })
      const kinds = []
      for (const table of ['session_journal', 'journal', 'session_events']) {
        try { const rows = dump.prepare(`SELECT payload_json FROM ${table} ORDER BY rowid DESC LIMIT 40`).all(); for (const row of rows) kinds.push(`${table}: ${String(row.payload_json).slice(0, 160)}`); break } catch { continue }
      }
      await writeFile(join(evidenceDir, 'failed-journal.txt'), kinds.join('\n') || '(no journal rows found)')
    } catch (dumpError) { await writeFile(join(evidenceDir, 'failed-journal.txt'), `journal dump failed: ${String(dumpError)}`) }
    throw error
  } finally {
    await browser?.close().catch(() => {})
    await stop(workerProcess)
    await stop(serverProcess)
    await new Promise(resolveClose => fixture.close(resolveClose))
    if (process.env.WEMUX_G44B_KEEP === '1') log(`KEEP temp dir: ${temp}`)
    else await rm(temp, { recursive: true, force: true })
  }
}

async function degraded(reason, piModels, preserveExistingBlocker = false) {
  await mkdir(blockedDir, { recursive: true })
  const blocked = `# BLOCKED: G44b 真实 Pi 审批链路本次未运行\n\n- 检查时间：${new Date().toISOString()}\n- Pi 模型预检：通过，\`${requestedModel}\` 存在（共 ${piModels.length} 个模型）\n- 已核实代码集成缺口：0\n- 本次未跑通原因：${reason}\n- 启用命令：\`WEMUX_REAL_AGENT_E2E=1 WEMUX_REAL_PI_MODEL=${requestedModel} node apps/e2e/approvals-pi-agent.mjs\`\n\n> 这是环境/付费网络测试开关的降级记录，不是用 mock 冒充真实链路通过。\n`
  let shouldWriteBlocker = !preserveExistingBlocker
  if (preserveExistingBlocker) {
    try { await access(join(blockedDir, 'BLOCKED.md')) } catch { shouldWriteBlocker = true }
  }
  if (shouldWriteBlocker) await writeFile(join(blockedDir, 'BLOCKED.md'), blocked)
  await writeFile(join(blockedDir, 'summary.md'), `# Pi Agent Approvals E2E 验收摘要\n\n- 结果：降级\n- 真实 Pi 链路：未运行\n- 原因：${reason}\n- G44b 静态集成缺口检查：0\n- BLOCKED：\`.scratch/feature-suite-b1/pi-agent-e2e/BLOCKED.md\`\n`)
  log(`DEGRADED: ${reason}`)
}

async function main() {
  await Promise.all([access(resolve(root, 'apps/server/dist/main.js')), access(resolve(root, 'apps/worker/dist/cli.js')), access(resolve(root, 'apps/web/dist')), access(chromiumPath)])
  await mkdir(evidenceDir, { recursive: true })
  const piModels = await piPreflight()
  const blockers = await integrationBlockers()
  assert.deepEqual(blockers, [], `G44b 集成缺口仍存在:\n${blockers.join('\n')}`)
  if (!requireReal) return degraded('未设置 WEMUX_REAL_AGENT_E2E=1，按约定保留付费/联网真实 Pi 测试开关。', piModels, true)
  try { await realChain(piModels) }
  catch (error) {
    await degraded(error instanceof Error ? error.stack ?? error.message : String(error), piModels)
    throw error
  }
}

await main()
