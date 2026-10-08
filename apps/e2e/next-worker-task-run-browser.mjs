/** Owned Server + actual Worker CLI + deterministic Test Agent + Next Chromium.
 * No synthetic Worker inventory, Run projection or paid model.
 * WEMUX_NEXT_TEST_DIST=/tmp/... node --import tsx apps/e2e/next-worker-task-run-browser.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createWemuxServer } from '../server/src/server.ts'
import { provisionAdministrator } from './session.ts'
import { ownedWorkerLaunch, removeOwnedServerDatabases } from './owned-worker-fixture.mjs'

assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'), 'owned temporary build required')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')
const evidence = await mkdtemp(join(tmpdir(), 'wemux-next-worker-run-browser-'))
const database = join(evidence, 'server.sqlite'), home = join(evidence, 'worker')
const email = 'next-worker-run@example.test', password = 'owned-worker-run-password'
const app = createWemuxServer({ databasePath: database, administratorEmails: [email], mail: {}, google: {}, webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST) })
let browser, worker, activePage, step = 'setup', simulatingLostCompletion = false
const checks = [], errors = [], runs = []
function launchWorker(args, origin) {
  const owned = ownedWorkerLaunch(args, origin)
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...owned.args], { cwd: process.cwd(), env: owned.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', text => { stdout += text })
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text })
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })) })
  void done.catch(() => {})
  return { child, done }
}
async function stopWorker() {
  if (!worker) return
  const current = worker; worker = undefined
  if (current.child.exitCode === null && current.child.signalCode === null) {
    current.child.kill('SIGCONT') // Never leave an owned paused fixture behind on failure.
    current.child.kill('SIGTERM')
  }
  const timer = setTimeout(() => current.child.kill('SIGKILL'), 10000)
  try { assert.equal((await current.done).code, 0, 'owned Worker closes gracefully') }
  finally { clearTimeout(timer) }
}
async function eventually(read, accept, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await delay(50) }
  throw Error(`Timed out: ${label}`)
}
try {
  const origin = await app.listen(0)
  const owner = await provisionAdministrator({ store: app.store, baseUrl: origin, email, password })
  const api = owner.api
  await api('/bootstrap', 'POST', {})
  const enrollment = await api('/enrollment-tokens', 'POST', {})
  const registration = launchWorker(['register', '--home', home, `--token=${enrollment.token}`, '--name', 'Owned Run Worker'], origin)
  const registered = await registration.done
  assert.equal(registered.code, 0, `Worker registration: ${registered.stderr}`)
  const workerId = JSON.parse(registered.stdout).workerId
  worker = launchWorker(['start', '--home', home, '--name', 'Owned Run Worker'], origin)
  await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities.some(c => c.agentKey === 'test' && c.availability.status === 'available'), 'actual Worker Test Agent available')
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    step = `${name}: provision real Worker Workspace and Task`
    const project = await api('/projects', 'POST', { name: `真实 Run ${name}`, teamId: 'default-team', requestId: `real-run-project-${name}` })
    const setupTask = async (purpose) => {
      const task = await api(`/projects/${project.id}/tasks`, 'POST', { title: `${purpose} ${name}`, requestId: `task-${purpose === '成功' ? 'success' : purpose === '取消' ? 'cancel' : purpose === '故障' ? 'failure' : 'queued'}-${name}` })
      const provision = await api(`/projects/${project.id}/tasks/${task.id}/workspaces`, 'POST', { name: `${purpose} 工作区 ${name}`, workerId, source: 'empty', requestId: `space-${purpose === '成功' ? 'success' : purpose === '取消' ? 'cancel' : purpose === '故障' ? 'failure' : 'queued'}-${name}` })
      const workspaceId = provision.workspace.id
      await eventually(() => api(`/workspaces/${workspaceId}`), value => value.placements.some(p => p.workerId === workerId && p.status === 'ready'), 'actual Worker provisioned placement')
      const assignment = { workspaceId, workerId, agentKey: 'test', modelId: 'test' }
      const assigned = await api(`/projects/${project.id}/tasks/${task.id}/assignment`, 'PUT', { version: provision.task.version, assignee: assignment })
      const todo = await api(`/projects/${project.id}/tasks/${task.id}`, 'PATCH', { version: assigned.version, status: 'todo' })
      await api(`/projects/${project.id}/tasks/${task.id}`, 'PATCH', { version: todo.version, status: 'in_progress' })
      return task.id
    }
    const taskId = await setupTask('成功')
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: email, password } })).status(), 200)
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(15000)
    page.on('pageerror', error => errors.push({ name, step, message: error.message }))
    page.on('console', message => { if (message.type() === 'error' && !(simulatingLostCompletion && message.text().includes('net::ERR_CONNECTION_RESET'))) errors.push({ name, step, message: message.text() }) })
    const surface = page.getByRole('region', { name: '任务运行' })
    const launch = async (id, goal) => {
      await page.goto(`${origin}/next/projects/${project.id}?task=${id}`)
      await surface.getByLabel('本次运行目标').fill(goal)
      const path = `/api/projects/${project.id}/tasks/${id}/launch`
      const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === path)
      await surface.getByRole('button', { name: '启动新 Run' }).click()
      const received = await response; assert.equal(received.status(), 200, await received.text())
      return (await received.json()).run
    }
    step = `${name}: real Run succeeds and Task stays in progress`
    const run = await launch(taskId, '[test-agent:pause-ms=1500] complete-task-run')
    runs.push({ name, outcome: 'succeeded', taskId, runId: run.id, sessionId: run.sessionId })
    const taskPath = `/projects/${project.id}/tasks/${taskId}`
    await eventually(() => api(`${taskPath}/runs`), value => value.items.some(r => r.id === run.id && r.status === 'running'), 'actual Run running')
    await eventually(() => api(`${taskPath}/runs`), value => value.items.some(r => r.id === run.id && r.status === 'succeeded'), 'actual Run succeeded', 45000)
    const events = await api(`/sessions/${run.sessionId}/events?fromSeq=1&limit=1000`)
    assert.ok(events.events.some(e => e.payload.kind === 'turn.finished' && e.payload.outcome === 'completed'), 'real Worker terminal Journal')
    assert.equal((await api(taskPath)).status, 'in_progress', 'Run success cannot auto-complete Task')
    await surface.getByRole('button', { name: '刷新运行状态' }).click()
    await surface.getByRole('heading', { name: '第 1 次执行：已成功' }).waitFor()
    await surface.getByRole('button', { name: '查看关联会话' }).click()
    assert.equal(new URL(page.url()).searchParams.get('session'), run.sessionId)
    const conversation = page.locator(`[data-conversation-session="${run.sessionId}"]`)
    await conversation.getByRole('region', { name: '权威会话元数据' }).getByText(`Agent：test`, { exact: false }).waitFor()
    await conversation.getByRole('region', { name: '会话历史' }).getByText(`Turn 已完成：`, { exact: false }).waitFor()
    assert.equal(await conversation.getByRole('alert').count(), 0, 'linked Session history has no handled read error')
    step = `${name}: reuse completed Session from browser and verify replay isolation`
    // The first Run must remain uncompleted: explicit completion is only legal for the latest succeeded attempt.
    await surface.getByRole('button', { name: '刷新运行状态' }).click()
    await surface.getByRole('radio', { name: '复用当前 Task 的 Session' }).check()
    const selector = surface.getByLabel('选择 Session')
    await eventually(() => api(`${taskPath}/sessions`), value => value.items.some(s => s.id === run.sessionId && s.runtimeState === 'idle' && s.freshness.status === 'synced' && !s.queuedMessages.length), 'Session ready for reuse')
    await surface.getByRole('button', { name: '刷新运行状态' }).click()
    await eventually(() => selector.locator(`option[value="${run.sessionId}"]`).count(), count => count === 1, 'completed Session offered for reuse')
    await selector.selectOption(run.sessionId)
    page.once('dialog', dialog => dialog.accept())
    await surface.getByLabel('本次运行目标').fill('[test-agent:pause-ms=1500] reused-task-run')
    const launchPath = `/api/projects/${project.id}/tasks/${taskId}/launch`
    const reuseResponse = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === launchPath)
    await surface.getByRole('button', { name: '启动新 Run' }).click()
    const response = await reuseResponse
    assert.equal(response.status(), 200, await response.text())
    const reused = (await response.json()).run
    assert.equal(reused.sessionId, run.sessionId, 'reuse retains the original Session ID')
    assert.equal(reused.attempt, 2, 'reuse is the second attempt')
    assert.equal(reused.request.mode, 'reuse')
    assert.equal(reused.request.reuseSessionId, run.sessionId)
    runs.push({ name, outcome: 'succeeded-reuse', taskId, runId: reused.id, sessionId: reused.sessionId, attempt: reused.attempt })
    // Replaying the exact request is idempotent even while execution is active;
    // changing its payload under the same requestId must not create a third Run.
    const ownerPost = body => fetch(`${origin}${launchPath}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: owner.cookie, 'x-csrf-token': owner.csrfToken }, body: JSON.stringify(body) })
    const replay = await ownerPost(reused.request)
    assert.equal(replay.status, 200, await replay.clone().text())
    assert.equal((await replay.json()).run.id, reused.id, 'old requestId returns same Run')
    const conflict = await ownerPost({ ...reused.request, prompt: 'changed payload must conflict' })
    assert.equal(conflict.status, 409, await conflict.text())
    await eventually(() => api(`${taskPath}/runs`), value => value.items.some(r => r.id === reused.id && r.status === 'succeeded'), 'actual reused Run succeeded', 45000)
    const secondEvents = await api(`/sessions/${run.sessionId}/events?fromSeq=1&limit=1000`)
    assert.ok(secondEvents.events.filter(e => e.payload.kind === 'turn.finished' && e.payload.outcome === 'completed').length >= 2, 'both real Worker turns finished in reused Session Journal')
    assert.equal((await api(taskPath)).status, 'in_progress', 'second Run success cannot auto-complete Task')
    await surface.getByRole('button', { name: '刷新运行状态' }).click()
    await surface.getByRole('heading', { name: '第 1 次执行：已成功' }).waitFor()
    await surface.getByRole('heading', { name: '第 2 次执行：已成功' }).waitFor()
    await surface.getByText(`执行记录 2 条`).waitFor()
    await surface.getByLabel('成果摘要').fill(`真实 Worker 完成 ${name}`)
    await surface.getByLabel('证据引用（每行一条，最多 20 条）').fill(`journal:${run.sessionId}`)
    // Simulate a lost completion response AFTER the server committed it: the
    // page must keep the exact request and recover only by replaying it.
    const completionPathname = `/api/projects/${project.id}/tasks/${taskId}/completion`
    const completionMatch = url => url.origin === origin && url.pathname === completionPathname
    await page.route(completionMatch, async route => { await route.fetch(); await route.abort('connectionreset') })
    simulatingLostCompletion = true
    await surface.getByRole('button', { name: '提交完成' }).click()
    await surface.getByText('原完成请求结果尚未确认', { exact: false }).waitFor()
    assert.equal((await api(taskPath)).status, 'done', 'server committed the completion despite the lost response')
    await page.reload()
    await surface.getByText('原完成请求结果尚未确认', { exact: false }).waitFor()
    await page.unroute(completionMatch)
    await surface.getByRole('button', { name: '重试原完成请求' }).click()
    await surface.getByText('已提交完成', { exact: false }).waitFor()
    simulatingLostCompletion = false
    assert.equal(await surface.getByRole('button', { name: '重试原完成请求' }).count(), 0)
    const completionActivities = (await api(`${taskPath}/activity`)).items.filter(item => item.payload?.action === 'completion.submitted')
    assert.equal(completionActivities.length, 1, 'exact replay must not duplicate the completion activity')
    const completion = completionActivities[0]
    assert.ok(completion, 'completion activity persisted')
    assert.equal(completion.payload.runId, reused.id, 'explicit completion uses the latest succeeded Run')
    assert.equal(completion.payload.summary, `真实 Worker 完成 ${name}`)
    assert.deepEqual(completion.payload.evidence, [`journal:${run.sessionId}`])
    await page.screenshot({ path: join(evidence, `${name}-real-run-completed.png`), fullPage: true })
    checks.push(`${name}: Worker CLI/Test Agent -> browser Session reuse, attempt 2 + replay/409 + two terminal Journal turns -> lost completion response recovered by exact requestId replay after reload -> done`)
    step = `${name}: real running Run cancellation`
    const cancelledTaskId = await setupTask('取消')
    const cancelledPath = `/projects/${project.id}/tasks/${cancelledTaskId}`
    const slow = await launch(cancelledTaskId, '[test-agent:pause-ms=60000] cancel-task-run')
    runs.push({ name, outcome: 'cancelled', taskId: cancelledTaskId, runId: slow.id, sessionId: slow.sessionId })
    await eventually(() => api(`${cancelledPath}/runs`), value => value.items.some(r => r.id === slow.id && r.status === 'running'), 'actual Run running before cancellation')
    await surface.getByRole('button', { name: '刷新运行状态' }).click()
    await surface.getByRole('button', { name: '取消本次 Run' }).click()
    await eventually(() => api(`${cancelledPath}/runs`), value => value.items.some(r => r.id === slow.id && r.status === 'cancelled'), 'actual Worker cancelled Run', 45000)
    const cancelledEvents = await api(`/sessions/${slow.sessionId}/events?fromSeq=1&limit=1000`)
    assert.ok(cancelledEvents.events.some(e => e.payload.kind === 'turn.finished' && e.payload.outcome === 'cancelled'), 'real Worker cancelled Turn Journal')
    await surface.getByRole('button', { name: '刷新运行状态' }).click()
    await surface.getByRole('heading', { name: '第 1 次执行：已取消' }).waitFor()
    assert.equal((await api(cancelledPath)).status, 'in_progress')
    await page.screenshot({ path: join(evidence, `${name}-real-run-cancelled.png`), fullPage: true })
    checks.push(`${name}: Worker CLI/Test Agent running Run cancellation -> terminal Journal and UI`)
    step = `${name}: queued cancellation with owned paused Worker`
    const queuedTaskId = await setupTask('排队取消')
    const queuedPath = `/projects/${project.id}/tasks/${queuedTaskId}`
    // Freeze ONLY the owned Worker after provisioning, so the real Server accepts
    // launch/cancel before the Worker can consume its queued commands.
    assert.ok(worker.child.kill('SIGSTOP'), 'pause owned Worker to hold command delivery')
    let queued
    try {
      queued = await launch(queuedTaskId, 'cancel-before-worker-start')
      runs.push({ name, outcome: 'cancelled-queued', taskId: queuedTaskId, runId: queued.id, sessionId: queued.sessionId })
      await eventually(() => api(`${queuedPath}/runs`), value => value.items.some(r => r.id === queued.id && r.status === 'pending'), 'Run remains pending while Worker paused')
      await surface.getByRole('button', { name: '刷新运行状态' }).click()
      await surface.getByRole('heading', { name: '第 1 次执行：排队中' }).waitFor()
      await surface.getByRole('button', { name: '取消本次 Run' }).click()
      await eventually(() => api(`${queuedPath}/runs`), value => value.items.some(r => r.id === queued.id && r.cancelRequestedAt), 'queued cancellation recorded before Worker resumes')
    } finally { worker.child.kill('SIGCONT') }
    await eventually(() => api(`${queuedPath}/runs`), value => value.items.some(r => r.id === queued.id && r.status === 'cancelled'), 'queued Run converges to cancelled', 45000)
    const queuedEvents = await api(`/sessions/${queued.sessionId}/events?fromSeq=1&limit=1000`)
    const queuedStarts = queuedEvents.events.filter(e => e.payload.kind === 'turn.started').length
    // Delivery may already have sent the enqueue before the paused Worker resumes;
    // cancellation must converge, but do not pretend this fixture guarantees no Turn start.
    if (queuedStarts) assert.ok(queuedEvents.events.some(e => e.payload.kind === 'turn.finished' && e.payload.outcome === 'cancelled'), 'started Turn has cancelled terminal Journal')
    await surface.getByRole('button', { name: '刷新运行状态' }).click()
    await surface.getByRole('heading', { name: '第 1 次执行：已取消' }).waitFor()
    assert.equal((await api(queuedPath)).status, 'in_progress')
    await page.screenshot({ path: join(evidence, `${name}-queued-run-cancelled.png`), fullPage: true })
    checks.push(`${name}: owned paused Worker -> pending Run cancellation -> cancelled and UI (Turn starts after resume: ${queuedStarts})`)
    step = `${name}: explicit Test Agent failure is a terminal Run, never Task completion`
    const failedTaskId = await setupTask('故障')
    const failedPath = `/projects/${project.id}/tasks/${failedTaskId}`
    const failedRun = await launch(failedTaskId, '[test-agent:fail] intentional acceptance failure')
    runs.push({ name, outcome: 'failed', taskId: failedTaskId, runId: failedRun.id, sessionId: failedRun.sessionId })
    const failedList = await eventually(() => api(`${failedPath}/runs`), value => value.items.some(r => r.id === failedRun.id && r.status === 'failed'), 'actual Test Agent failed Run', 45000)
    const failedRow = failedList.items.find(r => r.id === failedRun.id)
    assert.equal(failedRow.failure?.code, 'agent-error')
    assert.equal(failedRow.failure?.message, 'Test Agent injected failure')
    const failedEvents = await api(`/sessions/${failedRun.sessionId}/events?fromSeq=1&limit=1000`)
    assert.equal(failedEvents.events.filter(e => e.payload.kind === 'turn.finished' && e.payload.outcome === 'failed').length, 1, 'real Worker writes exactly one failed terminal Journal')
    assert.equal((await api(failedPath)).status, 'in_progress', 'failed Run cannot auto-complete Task')
    await surface.getByRole('button', { name: '刷新运行状态' }).click()
    await surface.getByRole('heading', { name: '第 1 次执行：失败' }).waitFor()
    await surface.getByText('故障：agent-error：Test Agent injected failure').waitFor()
    assert.equal(await surface.getByRole('button', { name: '提交完成' }).count(), 0, 'failed Run offers no explicit completion action')
    await page.screenshot({ path: join(evidence, `${name}-real-run-failed.png`), fullPage: true })
    checks.push(`${name}: Test Agent explicit failure -> terminal failed Journal, visible diagnostic, no completion`)
    await context.close(); activePage = undefined
  }
  assert.deepEqual(errors, [])
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ checks, errors, runs, runtime: 'actual Worker CLI + deterministic Test Agent, NOT native Runtime/model review' }, null, 2))
  console.log(JSON.stringify({ evidence, checks }))
} catch (error) {
  await activePage?.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {})
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ step, message: String(error), checks, errors, runs }, null, 2))
  throw error
} finally {
  const cleanup = { ownedBrowserClosed: false, ownedWorkerStopped: false, ownedServerClosed: false, workerHomeRemoved: false, serverDatabasesRemoved: false, failures: [] }
  // Attempt every owned-resource teardown even if a preceding close rejects.
  try { await browser?.close(); cleanup.ownedBrowserClosed = true } catch (error) { cleanup.failures.push(`browser: ${error}`) }
  try { await stopWorker(); cleanup.ownedWorkerStopped = true } catch (error) { cleanup.failures.push(`worker: ${error}`) }
  try { await app.close(); cleanup.ownedServerClosed = true } catch (error) { cleanup.failures.push(`server: ${error}`) }
  try { await rm(home, { recursive: true, force: true }); cleanup.workerHomeRemoved = true } catch (error) { cleanup.failures.push(`worker home: ${error}`) }
  try { await removeOwnedServerDatabases(database); cleanup.serverDatabasesRemoved = true } catch (error) { cleanup.failures.push(`server database: ${error}`) }
  await writeFile(join(evidence, 'cleanup.json'), JSON.stringify(cleanup, null, 2))
  assert.deepEqual(cleanup.failures, [], 'all owned browser, Worker and Server resources must be cleaned')
}
