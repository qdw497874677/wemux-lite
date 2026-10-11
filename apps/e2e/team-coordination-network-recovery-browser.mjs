#!/usr/bin/env node
/** Ticket 04: half-disconnected operation and recovery in the real browser.
 * Phase A: Worker is SIGKILLed mid-Turn (unknown result). The UI must not report ghost success,
 *          must stay interactive, and an explicit resend must complete exactly once after restart.
 * Phase B: the Server stops listening and every TCP connection (browser SSE + Worker WS) is
 *          destroyed mid-Turn. The UI must surface the failed read instead of hanging, and after
 *          the Server re-listens the Worker reconnects and history catches up.
 * Boundary: phase B is a connection-level outage on the same Server process (no process restart,
 *          no in-memory state loss). A real process restart would additionally lose nothing because
 *          all authority lives in SQLite; that path is covered by the Worker phases here.
 * WEMUX_NEXT_TEST_DIST=/tmp/... PLAYWRIGHT_CORE_PATH=... PLAYWRIGHT_CHROMIUM_PATH=...
 * TMPDIR must support SQLite WAL (on this host, use a disk directory rather than /tmp).
 * Deterministic Test Agent only; no paid Runtime, no production credentials, no persistent user data.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createWemuxServer } from '../server/src/server.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { login } from './session.ts'
import { ownedWorkerLaunch, removeOwnedServerDatabases } from './owned-worker-fixture.mjs'

assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'), 'use a disposable /tmp Web-next build copy')
assert.ok(process.env.PLAYWRIGHT_CORE_PATH && process.env.PLAYWRIGHT_CHROMIUM_PATH, 'explicit browser paths required')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH)
const dir = await mkdtemp(join(tmpdir(), 'wemux-net-recovery-'))
const database = join(dir, 'server.sqlite'), home = join(dir, 'worker')
const email = 'net-recovery-owner@example.test', password = 'net-recovery-test-only-password'
const app = createWemuxServer({ databasePath: database, administratorEmails: [email], mail: {}, google: {}, webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST) })
let worker, browser, step = 'setup'
const contexts = [], checks = [], errors = []
const eventually = async (read, accept, label, windowMs = 30000) => {
  const deadline = Date.now() + windowMs
  while (Date.now() < deadline) {
    const value = await read()
    if (accept(value)) return value
    await delay(100)
  }
  throw Error(`Timed out: ${label}`)
}
function launch(args, origin) {
  const isolated = ownedWorkerLaunch(args, origin)
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...isolated.args], { cwd: process.cwd(), env: isolated.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })) })
  void done.catch(() => {})
  return { child, done }
}
/** Completed Turns whose user message content equals the marker: the anti-ghost-success metric. */
const completedTurnsForMarker = events => marker => {
  let pendingMarkerTurn = null, completed = 0, interrupted = 0
  for (const event of events) {
    const payload = event.payload
    if (payload.kind === 'message.queued' && payload.content === marker) pendingMarkerTurn = true
    if (payload.kind === 'turn.started' && pendingMarkerTurn) pendingMarkerTurn = payload.turnId
    if (payload.kind === 'turn.finished' && pendingMarkerTurn === payload.turnId) {
      if (payload.outcome === 'completed') completed += 1
      if (payload.outcome === 'failed' && payload.failure?.code === 'interrupted') interrupted += 1
      pendingMarkerTurn = null
    }
  }
  return { completed, interrupted }
}
try {
  const origin = await app.listen(0)
  const sockets = new Set()
  app.server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await seedLocalAccount(app.store, { username: email, email, password, administrator: true })
  const owner = await login(origin, email, password), api = owner.api
  await api('/bootstrap', 'POST', {})
  const token = await api('/enrollment-tokens', 'POST', {})
  const registration = await launch(['register', '--home', home, `--token=${token.token}`, '--name', 'Net Recovery Worker'], origin).done
  assert.equal(registration.code, 0, 'owned Worker enrollment')
  const workerId = JSON.parse(registration.stdout).workerId
  worker = launch(['start', '--home', home, '--name', 'Net Recovery Worker'], origin)
  await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities.some(item => item.agentKey === 'test' && item.availability.status === 'available'), 'Test Agent capability')
  const project = await api('/projects', 'POST', { name: 'Net recovery placement', teamId: 'default-team', requestId: randomUUID() })
  const placed = await api('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Net recovery Workspace', source: 'empty', requestId: randomUUID() })
  await eventually(() => api(`/workspaces/${placed.workspace.id}`), value => value.placements.some(item => item.workerId === workerId && item.status === 'ready'), 'ready Workspace')
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  contexts.push(context)
  assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: email, password } })).status(), 200, 'browser login')
  const page = await context.newPage()
  page.setDefaultTimeout(30000)
  page.on('pageerror', () => errors.push({ phase: step }))
  await page.goto(`${origin}/next/teams`)
  const select = page.getByRole('combobox', { name: '协调执行环境' })
  await select.waitFor()
  await eventually(() => select.locator('option').count(), count => count > 1, 'authorized ready placement options')
  await select.selectOption({ index: 1 })
  await page.getByRole('textbox', { name: '协调首条消息' }).fill('net-recovery-baseline')
  await page.getByRole('button', { name: '发送并创建会话' }).click()
  const conversation = page.getByRole('region', { name: '任务会话对话' })
  await conversation.waitFor()
  await conversation.getByText(/Turn 已完成/).waitFor()
  const sessionId = await conversation.getAttribute('data-conversation-session')
  assert.ok(sessionId)
  const journal = async () => (await api(`/sessions/${sessionId}/events?fromSeq=1&limit=1000`)).events
  const composer = conversation.getByRole('textbox', { name: '新消息草稿' })
  const send = conversation.getByRole('button', { name: '发送新消息' })
  checks.push('baseline Team conversation established before any disruption')
  step = 'phase A: Worker SIGKILL mid-Turn leaves the result unknown'
  const crashMarker = '[test-agent:pause-ms=30000] net-recovery-crash-unknown'
  await composer.fill(crashMarker)
  await send.click()
  await conversation.getByRole('button', { name: /停止当前 Turn/ }).waitFor()
  {
    const deadline = Date.now() + 15000
    let recorded = []
    while (Date.now() < deadline) {
      const events = await journal()
      recorded = events.filter(event => event.payload.kind === 'message.queued').map(event => event.payload.content)
      if (recorded.includes(crashMarker)) break
      await delay(100)
    }
    if (!recorded.includes(crashMarker)) throw Error(`crash marker message journaled (recorded=${JSON.stringify(recorded)})`)
  }
  worker.child.kill('SIGKILL')
  const killed = await worker.done
  assert.equal(killed.signal, 'SIGKILL', `owned Worker hard-killed mid-Turn (code=${killed.code}, signal=${killed.signal}, stderr=${killed.stderr.slice(-400)})`)
  worker = null
  await eventually(() => api('/workers'), value => value.items.find(item => item.id === workerId)?.connectionState === 'offline', 'Worker offline projection')
  const beforeRestart = completedTurnsForMarker(await journal())(crashMarker)
  assert.equal(beforeRestart.completed, 0, 'no completed Turn may be claimed while the Worker is gone')
  assert.equal(await conversation.getByText('Turn 已完成').count(), 1, 'UI still shows only the baseline completed Turn')
  await conversation.getByRole('button', { name: '刷新会话历史' }).click()
  await conversation.getByRole('textbox', { name: '新消息草稿' }).fill('net-recovery-typed-while-offline')
  // 发送按钮离线时可被诚实地禁用（ freshness 标签提示 Worker 离线）；要求的是页面不假死：
  // 输入框可编辑、刷新按钮可点击，而不是强行允许发送。
  assert.equal(await conversation.getByText('Worker 离线').count() > 0 || await send.isDisabled(), true, 'offline state is surfaced honestly')
  assert.equal(await conversation.getByRole('button', { name: '刷新会话历史' }).isDisabled(), false, 'refresh stays clickable while the Worker is offline')
  checks.push('phase A: hard-killed mid-Turn produces no ghost success and the page stays interactive')
  step = 'phase A: Worker restart marks the interrupted Turn failed'
  worker = launch(['start', '--home', home, '--name', 'Net Recovery Worker'], origin)
  await eventually(() => api('/workers'), value => value.items.find(item => item.id === workerId)?.connectionState === 'online', 'Worker reconnect')
  await eventually(journal, events => completedTurnsForMarker(events)(crashMarker).interrupted === 1, 'interrupted Turn journaled as failed', 30000)
  await conversation.getByRole('button', { name: '刷新会话历史' }).click()
  await conversation.getByText(/Turn 失败/).first().waitFor()
  checks.push('phase A: restart closes the unknown result as failed (interrupted), visible in the browser')
  step = 'phase A: explicit resend completes exactly once'
  await composer.fill(crashMarker)
  await send.click()
  await eventually(journal, events => completedTurnsForMarker(events)(crashMarker).completed === 1, 'resent Turn completed', 60000)
  const afterResend = completedTurnsForMarker(await journal())(crashMarker)
  assert.equal(afterResend.completed, 1, 'exactly one completed Turn for the resent message')
  assert.equal(afterResend.interrupted, 1, 'the interrupted attempt stays recorded as failed')
  checks.push('phase A: explicit resend after unknown result completes exactly once (no duplicate success)')
  step = 'phase B: Server stops listening and all connections drop mid-Turn'
  const dropMarker = '[test-agent:pause-ms=25000] net-recovery-server-drop'
  await composer.fill(dropMarker)
  await send.click()
  await conversation.getByRole('button', { name: /停止当前 Turn/ }).waitFor()
  await eventually(journal, events => events.some(event => event.payload.kind === 'message.queued' && event.payload.content === dropMarker), 'drop marker journaled', 15000)
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  app.server.closeAllConnections?.()
  await new Promise(resolve => app.server.close(resolve))
  await delay(500)
  assert.equal(app.server.listening, false, 'Server is not listening during the outage')
  step = 'phase B: outage surfaces in the UI without freezing the page'
  await conversation.getByRole('button', { name: '刷新会话历史' }).click()
  await eventually(async () => page.getByRole('alert').filter({ hasText: '无法完成读取' }).count(), count => count > 0, 'failed read surfaced as an alert', 15000)
  await conversation.getByRole('textbox', { name: '新消息草稿' }).fill('net-recovery-draft-during-outage')
  assert.equal(await conversation.getByRole('button', { name: '刷新会话历史' }).isDisabled(), false, 'buttons remain enabled during the outage')
  checks.push('phase B: connection-level outage surfaces a failed read alert; the page does not hang')
  step = 'phase B: Server re-listens, Worker reconnects, history catches up'
  await new Promise((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(address.port, '127.0.0.1', () => { app.server.off('error', reject); resolve() })
  })
  await eventually(() => api('/workers'), value => value.items.find(item => item.id === workerId)?.connectionState === 'online', 'Worker WS reconnect after Server outage', 60000)
  await conversation.getByRole('button', { name: '刷新会话历史' }).click()
  await eventually(journal, events => completedTurnsForMarker(events)(dropMarker).completed === 1, 'dropped-connection Turn completed after recovery', 60000)
  await eventually(async () => {
    if (await conversation.getByText('net-recovery-server-drop').count() === 0) await conversation.getByRole('button', { name: '刷新会话历史' }).click()
    return conversation.getByText('net-recovery-server-drop').count()
  }, count => count > 0, 'dropped-connection Turn visible in browser', 30000)
  checks.push('phase B: Worker reconnects after the Server outage and the buffered Turn completes')
  step = 'phase B: composer usable after recovery'
  await composer.fill('net-recovery-after-recovery')
  await send.click()
  await eventually(journal, events => events.filter(event => event.payload.kind === 'message.queued' && event.payload.content === 'net-recovery-after-recovery').length === 1, 'post-recovery message journaled', 45000)
  await eventually(async () => {
    if (await conversation.getByText('net-recovery-after-recovery').count() === 0) await conversation.getByRole('button', { name: '刷新会话历史' }).click()
    return conversation.getByText('net-recovery-after-recovery').count()
  }, count => count > 0, 'post-recovery message visible in browser', 30000)
  await eventually(journal, events => completedTurnsForMarker(events)('net-recovery-after-recovery').completed === 1, 'post-recovery Turn completes exactly once', 45000)
  const final = completedTurnsForMarker(await journal())('net-recovery-after-recovery')
  assert.equal(final.completed, 1, 'post-recovery Turn completes exactly once')
  assert.equal(final.interrupted, 0, 'post-recovery Turn is not marked interrupted')
  checks.push('phase B: new messages complete after full recovery')
  assert.deepEqual(errors, [], 'browser page errors')
  console.log(JSON.stringify({ status: 'pass', checks }))
} catch (error) {
  // Never print login, registration token or Worker stdout/stderr.
  console.error(JSON.stringify({ status: 'fail', step, errorName: error?.name ?? 'Error', message: String(error?.message ?? ''), checks, pageErrorCount: errors.length }))
  process.exitCode = 1
} finally {
  for (const context of contexts) await context.close().catch(() => {})
  await browser?.close().catch(() => {})
  if (worker) {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGTERM')
    const timer = setTimeout(() => worker.child.kill('SIGKILL'), 10000)
    try { const stopped = await worker.done; assert.equal(stopped.code, 0, 'owned Worker graceful stop') }
    catch { process.exitCode = 1 }
    finally { clearTimeout(timer) }
  }
  if (app.server.listening) await app.close().catch(() => { process.exitCode = 1 })
  else await app.close().catch(() => { process.exitCode = 1 })
  await removeOwnedServerDatabases(database).catch(() => { process.exitCode = 1 })
  await rm(dir, { recursive: true, force: true }).catch(() => { process.exitCode = 1 })
}
