// Shared Web build on a local Worker-shaped HTTP host; Worker HTTP authorization is tested separately.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { once } from 'node:events'

const root = resolve(new URL('../..', import.meta.url).pathname)
const dist = join(root, 'apps/web/dist')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')
let session = null
let events = []
let activeTurnId = null
let queuePending = false
let approvalPending = false
let enrolled = false
let connectionPhase = 'offline'
const requests = []
const responseJson = (response, status, value, headers = {}) => response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(value))
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
  if (url.pathname === '/api/host') return responseJson(response, 200, { hostKind: 'local-worker', contractVersion: 1, capabilities: ['local-session'] })
  if (url.pathname.startsWith('/api/')) {
    requests.push(`${request.method} ${url.pathname}`)
    if (url.pathname === '/api/local/auth/session' && request.method === 'POST') {
      return responseJson(response, 201, { csrf: 'local-csrf' }, { 'set-cookie': 'wemux-local-session=local; Path=/; HttpOnly; SameSite=Strict' })
    }
    if (request.headers.cookie !== 'wemux-local-session=local') return responseJson(response, 401, { error: 'Authentication required' })
    if (request.method !== 'GET' && request.headers['x-wemux-csrf'] !== 'local-csrf') return responseJson(response, 403, { error: 'CSRF required' })
    if (url.pathname === '/api/local/auth/session' && request.method === 'DELETE') return responseJson(response, 204, null, { 'set-cookie': 'wemux-local-session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' })
    if (url.pathname === '/api/local/status') return responseJson(response, 200, { csrf: 'local-csrf', installation: { installationId: 'local', name: '本机 Worker' }, cluster: { enrolled, serverUrl: enrolled ? 'https://server.example' : undefined, connection: { phase: connectionPhase, failure: null } }, capabilities: [{ agentKey: 'test', displayName: '测试 Agent', mode: 'execution', version: '1', availability: { status: 'available' }, models: [{ modelId: 'test-model', displayName: '测试模型', source: 'detected' }] }] })
    if (url.pathname === '/api/local/agents' && request.method === 'GET') return responseJson(response, 200, { selections: [{ key: 'pi', executable: 'pi', source: 'PATH', selected: false }], capabilities: [] })
    if (url.pathname === '/api/local/agents/pi' && request.method === 'PUT') {
      const input = JSON.parse(await new Promise(resolve => { let text = ''; request.on('data', chunk => text += chunk); request.on('end', () => resolve(text)) }))
      assert.equal(input.executable, '/usr/bin/pi')
      return responseJson(response, 200, { selections: [{ key: 'pi', executable: '/usr/bin/pi', source: 'local', selected: true }], capabilities: [] })
    }
    if (url.pathname === '/api/local/agents/pi' && request.method === 'DELETE') return responseJson(response, 200, { selections: [{ key: 'pi', executable: 'pi', source: 'PATH', selected: false }], capabilities: [] })
    if (url.pathname === '/api/local/connectors' && request.method === 'GET') return responseJson(response, 200, { items: [], credentialCapability: 'unavailable' })
    if (url.pathname === '/api/local/cluster/discover' && request.method === 'POST') return responseJson(response, 200, { serverUrl: 'https://server.example', status: 200, ok: true, name: '测试 Server' })
    if (url.pathname === '/api/local/cluster/enroll' && request.method === 'POST') {
      const body = JSON.parse(await new Promise(resolve => { let text = ''; request.on('data', chunk => text += chunk); request.on('end', () => resolve(text)) }))
      assert.equal(body.token, 'one-time-secret')
      enrolled = true; connectionPhase = 'connecting'
      return responseJson(response, 201, { identity: { workerId: 'cluster-worker' } })
    }
    if (url.pathname === '/api/local/cluster/resume' && request.method === 'POST') { connectionPhase = 'online'; return responseJson(response, 202, { status: 'connecting' }) }
    if (url.pathname === '/api/local/cluster/pause' && request.method === 'POST') { connectionPhase = 'offline'; return responseJson(response, 200, { status: 'offline' }) }
    if (url.pathname === '/api/local/cluster/enrollment' && request.method === 'DELETE') { enrolled = false; connectionPhase = 'offline'; return responseJson(response, 204, null) }
    if (url.pathname === '/api/local/workbench/directories' && request.method === 'GET') return responseJson(response, 200, { items: [{ workspaceId: 'dir-1', name: 'repo', path: '/tmp/repo' }] })
    if (url.pathname === '/api/local/workbench/sessions' && request.method === 'GET') return responseJson(response, 200, { items: session ? [session] : [] })
    if (url.pathname === '/api/local/workbench/sessions' && request.method === 'POST') {
      const input = JSON.parse(await new Promise(resolve => { let text = ''; request.on('data', chunk => text += chunk); request.on('end', () => resolve(text)) }))
      assert.deepEqual([input.workspaceId, input.agentKey, input.modelId], ['dir-1', 'test', 'test-model'])
      session = { sessionId: 'local-session', binding: { workspaceId: 'dir-1', agent: { agentKey: 'test', workerId: 'local-worker' }, modelId: 'test-model' }, runtimeState: 'idle', activeTurnId: null }
      return responseJson(response, 201, session)
    }
    if (url.pathname.endsWith('/journal')) {
      const from = Number(url.searchParams.get('fromSeq'))
      const filtered = events.filter(event => event.seq >= from)
      return responseJson(response, 200, { events: filtered, throughSeq: filtered.at(-1)?.seq ?? from - 1, hasMore: false })
    }
    if (url.pathname.endsWith('/events')) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      response.write('retry: 1000\n\n')
      request.on('close', () => response.end())
      return
    }
    if (url.pathname.endsWith('/messages') && request.method === 'POST') {
      const input = JSON.parse(await new Promise(resolve => { let text = ''; request.on('data', chunk => text += chunk); request.on('end', () => resolve(text)) }))
      events.push({ sessionId: 'local-session', seq: events.length + 1, occurredAt: new Date().toISOString(), payload: { kind: 'message.queued', content: input.content, commandId: input.commandId, messageId: input.messageId, position: 0 } })
      if (input.content === '等待取消的消息') { queuePending = true; return responseJson(response, 202, { commandId: input.commandId, status: 'accepted' }) }
      activeTurnId = 'turn-1'
      events.push({ sessionId: 'local-session', seq: events.length + 1, occurredAt: new Date().toISOString(), payload: { kind: 'turn.started', turnId: activeTurnId, messageId: input.messageId } })
      if (input.content === '需要审批的请求') {
        approvalPending = true
        events.push({ sessionId: 'local-session', seq: events.length + 1, occurredAt: new Date().toISOString(), payload: { kind: 'approval.requested', turnId: activeTurnId, approvalId: 'approval-1', action: { tool: 'shell' }, reason: '允许执行工具？' } })
      }
      return responseJson(response, 202, { commandId: input.commandId, status: 'accepted' })
    }
    if (url.pathname.endsWith('/cancel') && request.method === 'DELETE') {
      assert.equal(queuePending, true)
      const commandId = url.pathname.split('/').at(-2)
      const queued = events.find(event => event.payload.kind === 'message.queued' && event.payload.commandId === commandId)
      assert.ok(queued)
      queuePending = false
      events.push({ sessionId: 'local-session', seq: events.length + 1, occurredAt: new Date().toISOString(), payload: { kind: 'message.cancelled', commandId, messageId: queued.payload.messageId } })
      return responseJson(response, 202, { commandId: 'cancel', status: 'accepted' })
    }
    if (url.pathname.endsWith('/resolve') && request.method === 'POST') {
      const body = JSON.parse(await new Promise(resolve => { let text = ''; request.on('data', chunk => text += chunk); request.on('end', () => resolve(text)) }))
      assert.ok(approvalPending && body.commandId && ['approve', 'deny'].includes(body.decision))
      approvalPending = false
      events.push({ sessionId: 'local-session', seq: events.length + 1, occurredAt: new Date().toISOString(), payload: { kind: 'approval.resolved', turnId: activeTurnId, approvalId: 'approval-1', decision: body.decision } })
      return responseJson(response, 202, { commandId: body.commandId, status: 'accepted' })
    }
    if (url.pathname.endsWith('/stop') && request.method === 'POST') {
      events.push({ sessionId: 'local-session', seq: events.length + 1, occurredAt: new Date().toISOString(), payload: { kind: 'turn.finished', turnId: activeTurnId, outcome: 'cancelled', failure: null } })
      activeTurnId = null
      return responseJson(response, 202, { commandId: 'stop', status: 'accepted' })
    }
    return responseJson(response, 404, { error: 'Not found' })
  }
  const file = url.pathname.startsWith('/assets/') ? join(dist, url.pathname) : join(dist, 'index.html')
  try {
    response.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file))
  } catch { response.writeHead(404).end() }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const base = `http://127.0.0.1:${server.address().port}`
  await page.goto(`${base}/local`)
  await page.getByRole('heading', { name: '管理员登录' }).waitFor()
  await page.getByLabel('用户名').fill('owner')
  await page.getByLabel('密码').fill('local-password')
  await page.getByRole('button', { name: '登录' }).click()
  await page.getByRole('button', { name: '新建会话' }).waitFor()
  await page.getByRole('combobox', { name: 'Agent' }).selectOption('test')
  await page.getByRole('combobox', { name: '模型' }).selectOption('test-model')
  await page.getByRole('button', { name: '新建会话' }).click()
  await page.getByRole('heading', { name: '本地会话' }).waitFor()
  await page.getByLabel('消息').fill('本地对话请求')
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByText('本地对话请求').waitFor()
  await page.getByLabel('消息').fill('等待取消的消息')
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByRole('region', { name: '排队消息' }).getByText('等待取消的消息').waitFor()
  await page.getByRole('button', { name: '取消排队' }).click()
  await page.getByRole('region', { name: '排队消息' }).waitFor({ state: 'detached' })
  await page.getByLabel('消息').fill('需要审批的请求')
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByRole('region', { name: '待处理审批' }).getByText(/允许执行工具/).waitFor()
  await page.getByRole('button', { name: '拒绝' }).click()
  await page.getByRole('region', { name: '待处理审批' }).waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '停止运行' }).click()
  await page.getByText('已取消', { exact: true }).first().waitFor()
  await page.reload()
  await page.getByText('本地对话请求').waitFor()
  await page.goto(`${base}/local/settings`)
  await page.getByRole('heading', { name: 'Agent 配置' }).waitFor()
  await page.getByLabel(/pi（PATH/).fill('/usr/bin/pi')
  await page.getByRole('button', { name: '使用此路径' }).click()
  await page.getByText('已显式指定').waitFor()
  await page.getByRole('button', { name: '恢复自动检测' }).click()
  await page.getByText('pi（PATH，自动检测）').waitFor()
  await page.goto(`${base}/local/cluster`)
  await page.getByText('未加入集群，本地对话仍可使用。').waitFor()
  await page.getByLabel('Server 地址').fill('https://server.example')
  await page.getByRole('button', { name: '探测 Server' }).click()
  await page.getByText(/探测成功/).waitFor()
  await page.getByLabel('一次性注册口令').fill('one-time-secret')
  await page.getByRole('checkbox', { name: /我已核对目标 Server/ }).check()
  await page.getByRole('button', { name: '确认加入集群' }).click()
  await page.getByText(/已注册：https:\/\/server.example/).waitFor()
  await page.getByRole('button', { name: '暂停连接' }).click()
  await page.getByText(/状态：offline/).waitFor()
  await page.getByRole('button', { name: '重连' }).click()
  await page.getByText(/状态：online/).waitFor()
  await page.getByRole('button', { name: '退出集群' }).click()
  await page.getByRole('button', { name: '确认退出' }).click()
  await page.getByText('未加入集群，本地对话仍可使用。').waitFor()
  await page.goto(`${base}/local/sessions/local-session`)
  await page.getByText('本地对话请求').waitFor()
  assert.ok(requests.includes('POST /api/local/workbench/sessions/local-session/messages'))
  assert.ok(requests.includes('DELETE /api/local/workbench/sessions/local-session/queue/' + events.find(event => event.payload.kind === 'message.queued' && event.payload.content === '等待取消的消息').payload.commandId + '/cancel'))
  assert.ok(requests.includes('POST /api/local/workbench/sessions/local-session/approvals/approval-1/resolve'))
  assert.ok(requests.includes('POST /api/local/workbench/sessions/local-session/turns/turn-1/stop'))
  assert.ok(!requests.some(path => path.includes('/api/auth/') || path.includes('/api/projects')))
  await page.getByRole('button', { name: '退出登录' }).click()
  await page.getByRole('heading', { name: '管理员登录' }).waitFor()
  assert.ok(requests.includes('DELETE /api/local/auth/session'))
  assert.deepEqual(errors, [])
  console.log('Local Session shared Web browser acceptance passed')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
