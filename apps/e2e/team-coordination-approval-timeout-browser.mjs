#!/usr/bin/env node
/** Ticket 04: native approval timeout path in the real browser.
 * A pending native approval has no wall-clock expiry in the runtime; the guaranteed path is
 * releasing the Turn. This script stops the Turn while an approval is pending and verifies:
 * the approval stops being actionable in the UI (projection expires it, not a human decision),
 * the Turn finishes as cancelled, and a late HTTP resolve of the expired approval is rejected
 * without resurrecting it. Connector approvals additionally self-expire after 5 minutes
 * (apps/worker/src/connectors/runtime.ts; covered by unit tests, docs/acceptance/web-next-approval-expiry.md).
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
const dir = await mkdtemp(join(tmpdir(), 'wemux-approval-timeout-'))
const database = join(dir, 'server.sqlite'), home = join(dir, 'worker')
const email = 'approval-timeout-owner@example.test', password = 'approval-timeout-test-only-password'
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
const readJournal = api => async sessionId => (await api(`/sessions/${sessionId}/events?fromSeq=1&limit=1000`)).events
try {
  const origin = await app.listen(0)
  await seedLocalAccount(app.store, { username: email, email, password, administrator: true })
  const owner = await login(origin, email, password), api = owner.api
  await api('/bootstrap', 'POST', {})
  const token = await api('/enrollment-tokens', 'POST', {})
  const registration = await launch(['register', '--home', home, `--token=${token.token}`, '--name', 'Approval Timeout Worker'], origin).done
  assert.equal(registration.code, 0, 'owned Worker enrollment')
  const workerId = JSON.parse(registration.stdout).workerId
  worker = launch(['start', '--home', home, '--name', 'Approval Timeout Worker'], origin)
  await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities.some(item => item.agentKey === 'test' && item.availability.status === 'available'), 'Test Agent capability')
  const project = await api('/projects', 'POST', { name: 'Approval timeout placement', teamId: 'default-team', requestId: randomUUID() })
  const placed = await api('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Approval timeout Workspace', source: 'empty', requestId: randomUUID() })
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
  await page.getByRole('textbox', { name: '协调首条消息' }).fill('approval-timeout-baseline')
  await page.getByRole('button', { name: '发送并创建会话' }).click()
  const conversation = page.getByRole('region', { name: '任务会话对话' })
  await conversation.waitFor()
  await conversation.getByText(/Turn 已完成/).waitFor()
  const sessionId = await conversation.getAttribute('data-conversation-session')
  assert.ok(sessionId)
  step = 'pending native approval is actionable before release'
  await conversation.getByRole('textbox', { name: '新消息草稿' }).fill('[test-agent:approval] approval-timeout-check')
  await conversation.getByRole('button', { name: '发送新消息' }).click()
  const approve = conversation.getByRole('button', { name: '批准操作' }), deny = conversation.getByRole('button', { name: '拒绝操作' })
  await approve.waitFor()
  await conversation.getByText('尚未处理的审批：1').waitFor()
  await conversation.getByText('审批请求（尚未处理）').waitFor()
  const journal = () => readJournal(api)(sessionId)
  const requested = (await journal()).find(event => event.payload.kind === 'approval.requested')?.payload
  assert.ok(requested?.approvalId && requested.turnId, 'approval.requested journaled')
  checks.push('pending native approval is visible and actionable with an honest 状态 label')
  step = 'stopping the Turn expires the pending approval'
  await conversation.getByRole('button', { name: /停止当前 Turn/ }).click()
  await eventually(journal, events => events.some(event => event.payload.kind === 'turn.finished' && event.payload.turnId === requested.turnId && event.payload.outcome === 'cancelled'), 'Turn cancelled by stop', 30000)
  await eventually(async () => {
    if (await conversation.getByText('没有待决审批。').count() === 0) await conversation.getByRole('button', { name: '刷新会话历史' }).click()
    return conversation.getByText('没有待决审批。').count()
  }, count => count > 0, 'approval no longer actionable')
  assert.equal(await approve.count(), 0, 'approve control removed after Turn release')
  assert.equal(await deny.count(), 0, 'deny control removed after Turn release')
  await conversation.getByText('审批请求（已过期）').waitFor()
  checks.push('releasing the Turn makes the pending approval expired (not humanly denied) and removes the controls')
  step = 'late HTTP resolve is rejected without resurrecting the approval'
  // HTTP 202 只代表命令入队；裁决在 Worker 执行层：Turn 已释放后同一 turnId 的 resolve 会被拒。
  // 这里验证的是终态：不产生 approval.resolved(approve)，UI 不复活操作入口。
  const lateResolve = await owner.raw(`/sessions/${sessionId}/runtime/approvals/${encodeURIComponent(requested.approvalId)}`, 'POST', { commandId: randomUUID(), turnId: requested.turnId, decision: 'approve' })
  assert.ok(lateResolve.status >= 200 && lateResolve.status < 300 || lateResolve.status >= 400, `late resolve transport result unexpected (${lateResolve.status})`)
  await eventually(journal, events => events.every(event => !(event.payload.kind === 'approval.resolved' && event.payload.approvalId === requested.approvalId && event.payload.decision === 'approve')), 'no fabricated approval.resolved(approve)', 10000)
  assert.equal((await journal()).some(event => event.payload.kind === 'approval.resolved' && event.payload.approvalId === requested.approvalId), false, 'no approval.resolved of any decision may appear')
  assert.equal(await conversation.getByRole('button', { name: '批准操作' }).count(), 0, 'approval stays non-actionable after the late attempt')
  checks.push('late resolve of the expired approval never fabricates approval.resolved or resurrects the controls')
  step = 'session stays usable after the expired approval'
  await conversation.getByRole('textbox', { name: '新消息草稿' }).fill('approval-timeout-followup')
  await conversation.getByRole('button', { name: '发送新消息' }).click()
  await eventually(journal, events => events.filter(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed').length >= 2, 'follow-up Turn completed', 45000)
  await conversation.getByText('approval-timeout-followup').last().waitFor()
  checks.push('composer and Turn execution remain usable after an expired approval')
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
  await app.close().catch(() => { process.exitCode = 1 })
  await removeOwnedServerDatabases(database).catch(() => { process.exitCode = 1 })
  await rm(dir, { recursive: true, force: true }).catch(() => { process.exitCode = 1 })
}
