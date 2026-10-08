// Real-source attention acceptance: real Worker CLI + deterministic Test Agent + Next Chromium.
// Covers ticket 07 item 6/8 slice for 01-10: real approval/run_problem sources, empty states,
// administrator-only dead letters, failure injection recovery, and per-step screenshots.
// WEMUX_NEXT_TEST_DIST=/tmp/... node --import tsx apps/e2e/next-attention-sources-browser.mjs
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createWemuxServer } from '../server/src/server.ts'
import { login as loginSession, provisionAdministrator } from './session.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { ownedWorkerLaunch } from './owned-worker-fixture.mjs'

assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'), 'owned temporary build required')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')
const evidence = await mkdtemp(join(tmpdir(), 'wemux-next-attention-sources-'))
const database = join(evidence, 'server.sqlite'), home = join(evidence, 'worker')
const email = 'attention-owner@example.test', password = 'owned-attention-password'
const app = createWemuxServer({ databasePath: database, administratorEmails: [email], mail: {}, google: {}, webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST) })
let browser, worker, activePage, step = 'setup', injectingFailure = false
const checks = [], errors = [], screenshots = []
function launchWorker(args, origin) {
  const owned = ownedWorkerLaunch(args, origin)
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...owned.args], { cwd: process.cwd(), env: owned.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', text => { stdout += text })
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text })
  const done = new Promise((resolveDone, reject) => { child.once('error', reject); child.once('close', code => resolveDone({ code, stdout, stderr })) })
  void done.catch(() => {})
  return { child, done }
}
async function stopWorker() {
  if (!worker) return
  const current = worker; worker = undefined
  if (current.child.exitCode === null && current.child.signalCode === null) { current.child.kill('SIGCONT'); current.child.kill('SIGTERM') }
  const timer = setTimeout(() => current.child.kill('SIGKILL'), 10000)
  try { assert.equal((await current.done).code, 0, 'owned Worker closes gracefully') } finally { clearTimeout(timer) }
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
  const managerAccount = await seedLocalAccount(app.store, { username: 'attention-manager', email: 'attention-manager@example.test', password })
  const outsiderAccount = await seedLocalAccount(app.store, { username: 'attention-outsider', email: 'attention-outsider@example.test', password })
  await app.store.transaction(async tx => {
    await tx.identity.saveMembership({ teamId: 'default-team', userId: managerAccount.id, role: 'member', joinedAt: new Date().toISOString() })
  })
  const enrollment = await api('/enrollment-tokens', 'POST', {})
  const registration = launchWorker(['register', '--home', home, `--token=${enrollment.token}`, '--name', 'Owned Attention Worker'], origin)
  const registered = await registration.done
  assert.equal(registered.code, 0, `Worker registration: ${registered.stderr}`)
  const workerId = JSON.parse(registered.stdout).workerId
  worker = launchWorker(['start', '--home', home, '--name', 'Owned Attention Worker'], origin)
  await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities.some(c => c.agentKey === 'test' && c.availability.status === 'available'), 'actual Worker Test Agent available')
  await api(`/workers/${workerId}/grants`, 'POST', { userId: managerAccount.id, role: 'use' })
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })

  const project = await api('/projects', 'POST', { name: '真实待办来源', teamId: 'default-team', requestId: 'attention-sources-project' })
  await api(`/projects/${project.id}/review-policy`, 'PATCH', { reviewPolicy: 'human', version: project.reviewPolicyVersion ?? 1 })
  await app.store.transaction(async tx => {
    await tx.identity.saveProjectGrant({ projectId: project.id, userId: managerAccount.id, role: 'manager' })
  })
  const setupTask = async (title, requestIdPrefix) => {
    const task = await api(`/projects/${project.id}/tasks`, 'POST', { title, requestId: `${requestIdPrefix}-task` })
    const provision = await api(`/projects/${project.id}/tasks/${task.id}/workspaces`, 'POST', { name: `${title} 工作区`, workerId, source: 'empty', requestId: `${requestIdPrefix}-space` })
    await eventually(() => api(`/workspaces/${provision.workspace.id}`), value => value.placements.some(p => p.workerId === workerId && p.status === 'ready'), 'workspace placement ready')
    const assigned = await api(`/projects/${project.id}/tasks/${task.id}/assignment`, 'PUT', { version: provision.task.version, assignee: { workspaceId: provision.workspace.id, workerId, agentKey: 'test', modelId: 'test' } })
    const todo = await api(`/projects/${project.id}/tasks/${task.id}`, 'PATCH', { version: assigned.version, status: 'todo' })
    await api(`/projects/${project.id}/tasks/${task.id}`, 'PATCH', { version: todo.version, status: 'in_progress' })
    return { taskId: task.id, assignment: { workspaceId: provision.workspace.id, workerId, agentKey: 'test', modelId: 'test' } }
  }
  // Owner's task: real successful Run then explicit human-review submission -> real approval source.
  const reviewSetup = await setupTask('成果审查任务', 'sources-review')
  const reviewRun = await api(`/projects/${project.id}/tasks/${reviewSetup.taskId}/launch`, 'POST', { requestId: 'sources-review-launch', mode: 'new', reuseSessionId: null, prompt: '[test-agent:pause-ms=1200] finish for review', assignment: reviewSetup.assignment })
  await eventually(() => api(`/projects/${project.id}/tasks/${reviewSetup.taskId}/runs`), value => value.items.some(r => r.id === reviewRun.run.id && r.status === 'succeeded'), 'review Run succeeded', 45000)
  await api(`/projects/${project.id}/tasks/${reviewSetup.taskId}/human-review-submission`, 'POST', { requestId: 'sources-review-submit', version: (await api(`/projects/${project.id}/tasks/${reviewSetup.taskId}`)).version, runId: reviewRun.run.id, summary: '真实 Run 后的人工审查提交', evidence: [`journal:${reviewRun.run.sessionId}`, `run:${reviewRun.run.id}`] })

  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    step = `${name}: manager sees real approval and run_problem sources`
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: 'attention-manager', password } })).status(), 200)
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(15000)
    const shot = async label => { const path = join(evidence, `${name}-${label}.png`); await page.screenshot({ path, fullPage: true }); screenshots.push(path) }
    page.on('pageerror', error => errors.push({ name, step, message: error.message }))
    page.on('response', response => { if (response.status() >= 400) errors.push({ name, step, message: `${response.status()} ${new URL(response.url()).pathname}${new URL(response.url()).search}` }) })
    page.on('console', message => { if (message.type() === 'error' && !(injectingFailure && message.text().includes('net::ERR_FAILED'))) errors.push({ name, step, message: message.text() }) })
    // Manager's own task: a real failed Run by this creator -> real run_problem source.
    step = `${name}: manager launches real failing Run`
    const failSetup = await setupTask(`异常任务 ${name}`, `sources-fail-${name}`)
    const failTaskId = failSetup.taskId
    await page.goto(`${origin}/next/projects/${project.id}?task=${failTaskId}`)
    const surface = page.getByRole('region', { name: '任务运行' })
    await surface.getByLabel('本次运行目标').fill('[test-agent:fail] provoke a real failure')
    const launchResponse = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/projects/${project.id}/tasks/${failTaskId}/launch`)
    await surface.getByRole('button', { name: '启动新 Run' }).click()
    assert.equal((await launchResponse).status(), 200)
    await surface.getByRole('button', { name: '刷新运行状态' }).click()
    await surface.getByRole('heading', { name: '第 1 次执行：失败' }).waitFor({ timeout: 45000 })
    await shot('failed-run')

    step = `${name}: attention lists real sources with navigation`
    await page.goto(`${origin}/next/attention`)
    const approvals = page.getByRole('region', { name: '任务人工审查', exact: true })
    const runProblems = page.getByRole('region', { name: '执行异常', exact: true })
    const dead = page.getByRole('region', { name: '渠道投递失败', exact: true })
    await approvals.getByRole('link', { name: '成果审查任务' }).waitFor()
    await runProblems.getByRole('link', { name: `异常任务 ${name}` }).waitFor()
    await dead.getByText('渠道死信仅实例管理员可处理，当前账号不是实例管理员。', { exact: true }).waitFor()
    await shot('manager-attention')
    await runProblems.getByRole('link', { name: `异常任务 ${name}` }).click()
    await page.getByRole('region', { name: '任务运行' }).getByRole('heading', { name: '第 1 次执行：失败' }).waitFor()
    assert.equal(new URL(page.url()).searchParams.get('run') !== null, true, 'run_problem deep link carries the failed run')
    await page.getByRole('region', { name: '任务运行' }).getByText('Test Agent injected failure', { exact: false }).waitFor()
    await shot('run-problem-target')
    await page.goto(`${origin}/next/attention`)
    await approvals.getByRole('link', { name: '成果审查任务' }).waitFor()
    await approvals.getByRole('link', { name: '成果审查任务' }).click()
    await page.getByRole('region', { name: '任务运行' }).getByRole('button', { name: '批准并完成' }).waitFor()
    await shot('approval-target')

    step = `${name}: injected page failure is recoverable and never looks empty`
    await page.goto(`${origin}/next/attention`)
    await approvals.getByRole('link', { name: '成果审查任务' }).waitFor()
    const pagesMatcher = url => url.pathname === '/api/attention/pages'
    let approvalFailures = 0
    const approvalRoute = async route => {
      if (approvalFailures < 1 && new URL(route.request().url()).searchParams.get('kind') === 'approval') { approvalFailures += 1; injectingFailure = true; await route.abort('failed'); return }
      await route.continue()
    }
    await page.route(pagesMatcher, approvalRoute)
    await page.getByRole('button', { name: '刷新待办' }).click()
    await approvals.getByRole('alert').waitFor()
    assert.equal(await approvals.getByText('已加载范围内暂无待办。', { exact: true }).count(), 0)
    await shot('injected-failure')
    injectingFailure = false
    await approvals.getByRole('button', { name: '重试任务人工审查' }).click()
    await approvals.getByRole('link', { name: '成果审查任务' }).waitFor()
    await page.unroute(pagesMatcher, approvalRoute)
    await shot('recovered')
    await context.close()
    checks.push(`${name}: real approval + run_problem sources, admin-only dead letters, injected failure recovery`)

    step = `${name}: outsider and administrator empty states`
    const adminContext = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    assert.equal((await adminContext.request.post(`${origin}/api/auth/login`, { data: { login: email, password } })).status(), 200)
    const adminPage = await adminContext.newPage(); activePage = adminPage; adminPage.setDefaultTimeout(15000)
    adminPage.on('pageerror', error => errors.push({ name, step, message: error.message }))
    adminPage.on('console', message => { if (message.type() === 'error') errors.push({ name, step, message: message.text() }) })
    await adminPage.goto(`${origin}/next/attention`)
    const adminApprovals = adminPage.getByRole('region', { name: '任务人工审查', exact: true })
    const adminRuns = adminPage.getByRole('region', { name: '执行异常', exact: true })
    const adminDead = adminPage.getByRole('region', { name: '渠道投递失败', exact: true })
    // Owner authored the review submission, so no decision capability: no approval item; no failed Run of their own.
    await adminApprovals.getByText('已加载范围内暂无待办。', { exact: true }).waitFor()
    await adminRuns.getByText('已加载范围内暂无待办。', { exact: true }).waitFor()
    await adminDead.getByText('已加载范围内暂无待办。', { exact: true }).waitFor()
    await adminPage.screenshot({ path: join(evidence, `${name}-admin-empty.png`), fullPage: true }); screenshots.push(join(evidence, `${name}-admin-empty.png`))
    const adminDeadLetterPage = await adminContext.request.get(`${origin}/api/attention/pages?kind=channel_dead_letter&limit=50`)
    assert.equal(adminDeadLetterPage.status(), 200, 'instance administrator reads dead-letter pages')
    await adminContext.close()
    const outsiderContext = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    assert.equal((await outsiderContext.request.post(`${origin}/api/auth/login`, { data: { login: 'attention-outsider', password } })).status(), 200)
    const outsiderPage = await outsiderContext.newPage(); activePage = outsiderPage; outsiderPage.setDefaultTimeout(15000)
    outsiderPage.on('pageerror', error => errors.push({ name, step, message: error.message }))
    outsiderPage.on('console', message => { if (message.type() === 'error') errors.push({ name, step, message: message.text() }) })
    await outsiderPage.goto(`${origin}/next/attention`)
    const outsiderApprovals = outsiderPage.getByRole('region', { name: '任务人工审查', exact: true })
    const outsiderRuns = outsiderPage.getByRole('region', { name: '执行异常', exact: true })
    await outsiderApprovals.getByText('已加载范围内暂无待办。', { exact: true }).waitFor()
    await outsiderRuns.getByText('已加载范围内暂无待办。', { exact: true }).waitFor()
    const bodyText = await outsiderPage.locator('body').innerText()
    assert.equal(bodyText.includes('成果审查任务'), false, 'outsider must not see approval titles')
    assert.equal(bodyText.includes(`异常任务 ${name}`), false, 'outsider must not see run problem titles')
    const outsiderDead = await outsiderContext.request.get(`${origin}/api/attention/pages?kind=channel_dead_letter&limit=50`)
    assert.equal(outsiderDead.status(), 403, 'non-administrator dead-letter pages stay forbidden')
    await outsiderPage.screenshot({ path: join(evidence, `${name}-outsider-empty.png`), fullPage: true }); screenshots.push(join(evidence, `${name}-outsider-empty.png`))
    await outsiderContext.close()
    checks.push(`${name}: administrator and outsider empty states without leaks`)
  }
  await writeFile(join(evidence, 'checks.json'), JSON.stringify({ passed: true, checks, screenshots, errors }, null, 2))
  console.log(JSON.stringify({ passed: true, checks, errors, evidence }, null, 2))
} catch (error) {
  if (activePage) { try { await activePage.screenshot({ path: '/tmp/wemux-attention-sources-debug.png', fullPage: true }) } catch { /* page may be gone */ } }
  console.error(JSON.stringify({ failed: step, message: error instanceof Error ? error.message : String(error), checks, errors, evidence }, null, 2))
  process.exitCode = 1
} finally {
  await stopWorker()
  await browser?.close()
  await app.close()
}
