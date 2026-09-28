import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs'

const root = process.cwd()
const evidenceDir = resolve(root, '.scratch/g44b-real')
const blockedDir = resolve(root, '.scratch/feature-suite-b1/pi-agent-e2e')
const chromiumPath = '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'
const piPath = '/opt/data/.npm-global/bin/pi'
const requestedModel = process.env.WEMUX_REAL_PI_MODEL ?? 'my-codex/gpt-5.6-sol'
const requireReal = process.env.WEMUX_REAL_AGENT_E2E === '1'
const adminEmail = 'g44b-admin@example.com'
const password = 'g44b-real-pi-password'
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
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
  const fixtureOrigin = `http://127.0.0.1:${fixturePort}`
  const logs = { server: '', worker: '' }, requests = []
  const fixture = createHttpServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : null })
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted: true, fixture: 'g44b' }))
  })
  await new Promise((resolveListen, reject) => fixture.once('error', reject).listen(fixturePort, '127.0.0.1', resolveListen))
  let serverProcess, workerProcess, browser
  try {
    serverProcess = child(resolve(root, 'apps/server/dist/main.js'), [], { PORT: String(serverPort), HOST: '127.0.0.1', WEMUX_ADMIN_EMAILS: adminEmail, WEMUX_DATABASE_PATH: join(temp, 'server.sqlite'), WEMUX_PUBLIC_URL: origin, WEMUX_SMTP_FROM: 'Wemux <no-reply@example.com>', WEMUX_MAIL_OUTBOX: outbox, WEMUX_CAPABILITY_SECRET: randomBytes(32).toString('hex'), WEMUX_CONNECTOR_ENCRYPTION_KEY: randomBytes(32).toString('hex'), WEMUX_WEB_DIST: resolve(root, 'apps/web/dist') }, logs, 'server')
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
    workerProcess = child(resolve(root, 'apps/worker/dist/cli.js'), ['start', '--home', workerHome, '--name', 'G44b Pi Worker'], { HOME: '/opt/data', PATH: `/opt/data/.npm-global/bin:${process.env.PATH ?? ''}` }, logs, 'worker')
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
    const created = await api('/sessions', 'POST', { requestId: randomUUID(), workspaceId: workspaceResult.workspace.id, workerId, title: 'G44b Real Pi', agentKey: 'pi', modelId: selectedModel.modelId, shareScope: 'owner-only' })
    await eventually(() => api(`/commands/${created.commandId}`), value => value.status === 'accepted' || value.status === 'completed', 'Session 创建')
    const requestId = randomUUID(), toolCallId = randomUUID()
    const prompt = `只调用一次 http_call，不要调用其他工具。参数必须是 connectorId=${connector.id}, connectorRevision=${connector.revision}, operationId=createItem, requestId=${requestId}, toolCallId=${toolCallId}, input={"body":{"source":"real-pi","title":"approval fixture"}}。审批后等待工具结果，然后用一句中文确认完成。`
    const message = await api(`/sessions/${created.session.id}/messages`, 'POST', { content: prompt })
    await eventually(() => api(`/commands/${message.commandId}`), value => value.status === 'accepted' || value.status === 'completed', '消息接收')
    const pendingPage = await eventually(() => api(`/approvals?projectId=${project.id}&status=pending`), value => value.items?.some(item => item.source?.kind === 'session_tool' && item.source.sessionId === created.session.id), 'HTTP Connector pending approval', 180_000)
    const pending = pendingPage.items.find(item => item.source?.kind === 'session_tool' && item.source.sessionId === created.session.id)

    browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'dark' })
    await context.addCookies([{ name: 'wemux_login_session', value: cookie.split('=')[1], domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }])
    const page = await context.newPage()
    await page.goto(`${origin}/approvals`)
    await page.getByText(pending.title, { exact: true }).waitFor()
    await page.screenshot({ path: join(evidenceDir, '01-real-pi-http-call-pending.png'), fullPage: true })

    await api(`/approvals/${encodeURIComponent(pending.projectionKey)}/decisions`, 'POST', { requestId: randomUUID(), decision: 'approve', sourceRevision: pending.sourceRevision, note: 'G44b 真实 Pi 验收批准' })
    const events = await eventually(() => api(`/sessions/${created.session.id}/events?fromSeq=1&limit=1000`), value => value.events?.some(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed') && requests.length === 1, 'Pi 恢复、fixture 请求与 turn 完成', 180_000)
    assert.equal(requests[0].method, 'POST')
    assert.equal(requests[0].url, '/items')
    assert.deepEqual(requests[0].body, { source: 'real-pi', title: 'approval fixture' })
    assert.ok(events.events.some(event => event.payload.kind === 'approval.requested' && event.payload.approvalId === toolCallId))
    assert.ok(events.events.some(event => event.payload.kind === 'approval.resolved' && event.payload.approvalId === toolCallId && event.payload.decision === 'approve'))
    await page.reload()
    await page.getByText('已批准', { exact: true }).first().waitFor()
    await page.screenshot({ path: join(evidenceDir, '02-real-pi-http-call-approved.png'), fullPage: true })
    await page.goto(`${origin}/timeline`)
    await page.getByRole('heading', { name: '时间线' }).waitFor()
    await page.screenshot({ path: join(evidenceDir, '03-real-pi-timeline.png'), fullPage: true })
    await writeFile(join(evidenceDir, 'summary.md'), `# G44b 真实 Pi HTTP Connector 审批验收\n\n- 结果：通过\n- Pi 模型：\`${requestedModel}\`\n- Worker：\`${workerId}\`\n- Session：\`${created.session.id}\`\n- Connector：\`${connector.id}\` revision ${connector.revision}\n- Approval：\`${pending.projectionKey}\`\n- fixture：收到 1 次 \`POST /items\`，请求体为 \`${JSON.stringify(requests[0].body)}\`\n- Journal：同时包含 \`approval.requested\`、\`approval.resolved(approve)\`、\`turn.finished(completed)\`\n- 截图：\`.scratch/g44b-real/01-real-pi-http-call-pending.png\`、\`.scratch/g44b-real/02-real-pi-http-call-approved.png\`、\`.scratch/g44b-real/03-real-pi-timeline.png\`\n`)
    await rm(join(blockedDir, 'BLOCKED.md'), { force: true })
    log('REAL PASS: Pi → http_call → pending → approve → fixture → turn completed')
  } catch (error) {
    await writeFile(join(evidenceDir, 'failed-server.log'), logs.server)
    await writeFile(join(evidenceDir, 'failed-worker.log'), logs.worker)
    throw error
  } finally {
    await browser?.close().catch(() => {})
    await stop(workerProcess)
    await stop(serverProcess)
    await new Promise(resolveClose => fixture.close(resolveClose))
    await rm(temp, { recursive: true, force: true })
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
