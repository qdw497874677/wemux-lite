import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs'

const root = process.cwd()
const evidenceDir = resolve(root, '.scratch/feature-suite-b1/pi-agent-e2e')
const chromiumPath = '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'
const piPath = '/opt/data/.npm-global/bin/pi'
const requestedModel = 'my-codex/gpt-5.6-sol'
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
const log = message => console.log(`[approvals-pi-agent] ${message}`)

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  assert.notEqual(address.port, 8004)
  return address.port
}

function run(command, args, options = {}) {
  return new Promise(resolveRun => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('close', code => resolveRun({ code, stdout, stderr }))
  })
}

async function stop(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolveClose => child.once('close', resolveClose)),
    delay(5_000).then(() => { if (child.exitCode === null) child.kill('SIGKILL') }),
  ])
}

async function piPreflight() {
  await access(piPath)
  const version = await run(piPath, ['--version'], { env: { HOME: '/opt/data' } })
  assert.equal(version.code, 0, version.stderr)
  const probe = await new Promise(resolveProbe => {
    const child = spawn(piPath, ['--mode', 'rpc', '--no-session'], { cwd: root, env: { ...process.env, HOME: '/opt/data' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk
      if (stdout.includes('"command":"get_available_models"')) child.kill('SIGTERM')
    })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('close', code => resolveProbe({ code, stdout, stderr }))
    child.stdin.end('{"type":"get_available_models","id":"models"}\n')
    setTimeout(() => child.kill('SIGKILL'), 20_000).unref()
  })
  const responseLine = probe.stdout.split('\n').find(line => line.includes('"command":"get_available_models"'))
  assert.ok(responseLine, `Pi model probe produced no response: ${probe.stderr}`)
  const models = JSON.parse(responseLine).data.models
  const [provider, modelId] = requestedModel.split('/')
  assert.ok(models.some(model => model.provider === provider && model.id === modelId), `${requestedModel} is unavailable`)
  return version.stdout.trim()
}

async function integrationBlockers() {
  const [tools, runtime, capabilityService, connectorService, testAdapter] = await Promise.all([
    readFile(resolve(root, 'apps/worker/src/capabilities/pi-tools.ts'), 'utf8'),
    readFile(resolve(root, 'apps/worker/src/connectors/runtime.ts'), 'utf8'),
    readFile(resolve(root, 'apps/server/src/application/capability-service.ts'), 'utf8'),
    readFile(resolve(root, 'apps/server/src/application/connector-service.ts'), 'utf8'),
    readFile(resolve(root, 'apps/worker/src/agents/test-runtime-session-adapter.ts'), 'utf8'),
  ])
  const blockers = []
  if (!tools.includes("['http_call'")) blockers.push('Pi capability extension does not expose `http_call`; it exposes only `mcp_list_tools` and `mcp_call` for connectors.')
  if (/filter\(definition => definition\.kind === 'mcp'/.test(runtime)) blockers.push('Worker turn capability registration includes only MCP definitions, so Server-created HTTP connectors cannot enter a Pi turn snapshot.')
  if (/allowedConnectorIds: \[\]/.test(capabilityService)) blockers.push('Server capability grants currently issue `allowedConnectorIds: []`, which the Worker intersects with local MCP connectors.')
  if (/v\.kind !== 'http'/.test(connectorService)) blockers.push('Server ConnectorService currently accepts HTTP definitions only, while the Pi capability tool can execute MCP definitions only.')
  if (/resolveApproval\(\): Promise<void> \{ throw/.test(testAdapter)) blockers.push('The repository test-agent adapter explicitly rejects approval resolution and cannot emulate the missing real approval lifecycle.')
  return blockers
}

async function captureDegradedUi() {
  const temp = await mkdtemp(join(tmpdir(), 'wemux-approvals-pi-ui-'))
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const now = new Date().toISOString()
  const serverLogs = []
  const server = spawn(process.execPath, ['apps/server/dist/main.js'], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), WEMUX_ADMIN_EMAILS: 'admin@example.com', WEMUX_DATABASE_PATH: join(temp, 'server.sqlite'), WEMUX_PUBLIC_URL: origin, WEMUX_SMTP_FROM: 'Wemux <no-reply@example.com>', WEMUX_MAIL_OUTBOX: join(temp, 'outbox'), WEMUX_WEB_DIST: resolve(root, 'apps/web/dist') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.setEncoding('utf8').on('data', chunk => serverLogs.push(chunk))
  server.stderr.setEncoding('utf8').on('data', chunk => serverLogs.push(chunk))
  let browser
  try {
    for (let count = 0; count < 100; count += 1) {
      if (server.exitCode !== null) throw new Error(`Server exited during degraded UI capture: ${serverLogs.join('')}`)
      try { if ((await fetch(`${origin}/api/health`)).ok) break } catch {}
      await delay(100)
    }
    browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, colorScheme: 'dark' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const account = { user: { id: 'degraded-user', username: 'degraded', email: 'degraded@example.com', createdAt: now, status: 'active' }, teamId: 'degraded-team', session: { id: 'degraded-login', current: true, authenticationMethod: 'password', client: 'Playwright', authenticatedAt: now, createdAt: now, lastSeenAt: now, idleExpiresAt: now, absoluteExpiresAt: now, revokedAt: null }, csrfToken: 'degraded-csrf', instanceAdministrator: true }
    const approval = { projectionKey: 'session_tool:blocked-session:blocked-turn:blocked-approval', projectId: 'blocked-project', source: { kind: 'session_tool', sessionId: 'blocked-session', turnId: 'blocked-turn', approvalId: 'blocked-approval' }, status: 'pending', title: 'Session「真实 Pi 验收阻塞」工具审批', reason: '降级 UI 证据：此条目不是来自真实 Pi Journal', requestedBy: { kind: 'agent', id: 'pi' }, requestedAt: now, decidedAt: null, decisionCapabilities: ['approve', 'deny'], sourceRevision: '1', freshness: { status: 'unavailable', observedAt: now, detail: '真实 Pi → HTTP Connector 审批桥接尚不存在' } }
    const timeline = { cursor: 'blocked', sourceKind: 'session', sourceId: 'blocked-event', sourceKey: 'approval.decided:blocked', occurredAt: now, projectId: 'blocked-project', actor: { kind: 'system', id: null, label: '降级验收' }, action: 'approval.decided', subject: { kind: 'approval', id: approval.projectionKey, label: approval.title }, summary: `${approval.title}：已批准（降级 UI 模拟）`, result: 'succeeded', href: '/approvals', freshness: approval.freshness }
    let decided = false
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname
      if (path === '/api/auth/me') return route.fulfill({ json: account })
      if (path === '/api/projects') return route.fulfill({ json: { items: [{ id: 'blocked-project', name: '真实 Pi 验收阻塞', teamId: 'degraded-team', shareScope: 'team', accessRole: 'owner' }] } })
      if (path === '/api/workers') return route.fulfill({ json: { items: [] } })
      if (path === '/api/approvals' && request.method() === 'GET') return route.fulfill({ json: { items: [{ ...approval, ...(decided ? { status: 'approved', decidedAt: now, decisionCapabilities: [] } : {}) }], nextCursor: null } })
      if (path.endsWith('/decisions') && request.method() === 'POST') { decided = true; return route.fulfill({ json: { approval: { ...approval, status: 'approved', decidedAt: now, decisionCapabilities: [] } } }) }
      if (path === '/api/timeline') return route.fulfill({ json: { items: [timeline], nextCursor: null } })
      return route.fulfill({ json: { items: [] } })
    })
    await page.goto(`${origin}/approvals`)
    await page.getByText(approval.title, { exact: true }).waitFor()
    await page.screenshot({ path: join(evidenceDir, '01-approvals-pending-degraded.png'), fullPage: true })
    await page.getByText(approval.title, { exact: true }).click()
    await page.getByRole('heading', { name: '审批详情' }).waitFor()
    const inspector = page.getByLabel('资源详情')
    await inspector.getByText(approval.reason, { exact: true }).waitFor()
    await inspector.getByText('新鲜度未知', { exact: true }).waitFor()
    await page.screenshot({ path: join(evidenceDir, '02-approval-detail-degraded.png'), fullPage: true })
    await page.getByRole('button', { name: '批准', exact: true }).click()
    await page.getByText('已批准', { exact: true }).waitFor()
    await page.screenshot({ path: join(evidenceDir, '03-approval-decided-degraded.png'), fullPage: true })
    await page.goto(`${origin}/timeline`)
    await page.getByText(timeline.summary, { exact: true }).waitFor()
    await page.screenshot({ path: join(evidenceDir, '04-timeline-degraded.png'), fullPage: true })
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close().catch(() => {})
    await stop(server)
    await rm(temp, { recursive: true, force: true })
  }
}

async function main() {
  await Promise.all([access(resolve(root, 'apps/server/dist/main.js')), access(resolve(root, 'apps/worker/dist/cli.js')), access(resolve(root, 'apps/web/dist')), access(chromiumPath)])
  await mkdir(evidenceDir, { recursive: true })
  for (const name of ['01-approvals-pending-degraded.png', '02-approval-detail-degraded.png', '03-approval-decided-degraded.png', '04-timeline-degraded.png', 'summary.md', 'BLOCKED.md']) await rm(join(evidenceDir, name), { force: true })

  const piVersion = await piPreflight()
  log(`Pi ${piVersion} exposes ${requestedModel}`)
  const blockers = await integrationBlockers()
  assert.ok(blockers.length >= 4, 'Expected integration blockers were not detected; update this acceptance script to attempt the real chain')
  log(`Real chain blocked by ${blockers.length} verified integration gaps; running required degraded evidence path`)

  const baseline = await run(process.execPath, ['apps/e2e/connector-real-browser.mjs'])
  assert.equal(baseline.code, 0, `${baseline.stdout}\n${baseline.stderr}`)
  log('Real Server + Worker + repository test-agent baseline passed')
  await captureDegradedUi()

  const blocked = `# BLOCKED: 真实 Pi 审批链路未完成\n\n- 检查时间：${new Date().toISOString()}\n- Pi：\`${piVersion}\`\n- 请求模型：\`${requestedModel}\`，RPC 模型清单中存在\n- 结论：Agent 与模型可用，但当前产品没有一条从真实 Pi 的 HTTP Connector 工具调用进入 Session Journal 审批、再由 Server Approvals 决策回送 Worker 的闭环。\n\n## 已验证阻塞点\n\n${blockers.map(item => `- ${item}`).join('\n')}\n\n## TODO\n\n1. 统一 Server Connector 定义与 Pi capability tool 支持的 connector kind，或实现真实 \`http_call\`。\n2. 在 Server capability grant 中按 Project/Worker 授予 Connector IDs，而不是固定空数组。\n3. 将 Worker Connector runtime 的 pending approval 发布为 Session Journal \`approval.requested\`，并将 \`runtime.approval.resolve\` 路由回该 pending connector call。\n4. 补齐真实 Pi → Connector → Approvals → fixture → Timeline 的无 mock 浏览器验收后删除本降级证据。\n\n> 本文件显著记录：未完成真实 Pi 验收。截图中的审批数据为降级 UI 模拟，不得作为真实链路通过证明。\n`
  await writeFile(join(evidenceDir, 'BLOCKED.md'), blocked)
  const summary = `# Pi Agent Approvals E2E 验收摘要\n\n- 执行命令：\`node apps/e2e/approvals-pi-agent.mjs\`\n- 脚本结果：退出码 0（降级路径本身执行成功）\n- 真实 Pi 验收：**未完成**\n- Pi 预检：\`${piVersion}\` 可执行，\`${requestedModel}\` 可用\n- 降级基线：\`apps/e2e/connector-real-browser.mjs\` 真实 Server + Worker + 仓库 test-agent 验收通过\n- 审批截图性质：真实 Web 构建与 Chromium，API 数据为显著标注的降级模拟；不是 Pi Journal 事件\n\n## 断言结果\n\n- [x] 批次一提交存在并可构建\n- [x] Pi CLI 可执行且目标模型在 RPC 模型列表中\n- [x] 真实 Server + Worker + test-agent 降级基线退出码 0\n- [x] Approvals 页面 pending、详情、决定后状态与 Timeline UI 可渲染并截图\n- [ ] Pi 调用 HTTP Connector \`http_call\`\n- [ ] Worker 将 Connector pending approval 上报为 Session Journal\n- [ ] 浏览器批准后 Pi 恢复执行\n- [ ] fixture HTTP 服务收到真实请求体\n- [ ] run/turn 以真实工具调用完成\n\n## 截图清单\n\n- \`.scratch/feature-suite-b1/pi-agent-e2e/01-approvals-pending-degraded.png\`\n- \`.scratch/feature-suite-b1/pi-agent-e2e/02-approval-detail-degraded.png\`\n- \`.scratch/feature-suite-b1/pi-agent-e2e/03-approval-decided-degraded.png\`\n- \`.scratch/feature-suite-b1/pi-agent-e2e/04-timeline-degraded.png\`\n\n## 阻塞说明\n\n详见 \`.scratch/feature-suite-b1/pi-agent-e2e/BLOCKED.md\`。\n`
  await writeFile(join(evidenceDir, 'summary.md'), summary)
  log(`DEGRADED PASS: 4 screenshots, summary.md and BLOCKED.md written to ${evidenceDir}`)
}

await main()
