/** Owned Server + actual Worker CLI + deterministic Test Agent + Next Chromium.
 * Exercises the frozen two-stage human review chain end to end with three
 * distinct real accounts (submitter, stage-1 reviewer, stage-2 reviewer).
 * WEMUX_NEXT_TEST_DIST=/tmp/... node --import tsx apps/e2e/next-multi-stage-review-browser.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createWemuxServer } from '../server/src/server.ts'
import { provisionAdministrator } from './session.ts'
import { ownedWorkerLaunch } from './owned-worker-fixture.mjs'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'

assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'), 'owned temporary build required')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')
const evidence = await mkdtemp(join(tmpdir(), 'wemux-next-multi-stage-review-'))
const database = join(evidence, 'server.sqlite'), home = join(evidence, 'worker')
const email = 'next-stage-owner@example.test', password = 'owned-stage-owner-password'
const app = createWemuxServer({ databasePath: database, administratorEmails: [email], mail: {}, google: {}, webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST) })
let browser, worker, activePage, step = 'setup'
const checks = [], errors = []
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
    current.child.kill('SIGCONT')
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
async function seededManager(username, mail) {
  const user = await seedLocalAccount(app.store, { username, email: mail, password: 'owned-stage-manager-password' })
  return user
}
try {
  const origin = await app.listen(0)
  const owner = await provisionAdministrator({ store: app.store, baseUrl: origin, email, password })
  const api = owner.api
  await api('/bootstrap', 'POST', {})
  const enrollment = await api('/enrollment-tokens', 'POST', {})
  const registration = launchWorker(['register', '--home', home, `--token=${enrollment.token}`, '--name', 'Owned Stage Worker'], origin)
  const registered = await registration.done
  assert.equal(registered.code, 0, `Worker registration: ${registered.stderr}`)
  const workerId = JSON.parse(registered.stdout).workerId
  worker = launchWorker(['start', '--home', home, '--name', 'Owned Stage Worker'], origin)
  await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities.some(c => c.agentKey === 'test' && c.availability.status === 'available'), 'actual Worker Test Agent available')
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    step = `${name}: project with multi-stage default and three real accounts`
    const project = await api('/projects', 'POST', { name: `多阶段审查 ${name}`, teamId: 'default-team', requestId: `stage-project-${name}` })
    await api(`/projects/${project.id}/review-policy`, 'PATCH', { reviewPolicy: 'multi-stage', version: project.reviewPolicyVersion ?? 1 })
    const first = await seededManager(`stage-one-${name}`, `stage-one-${name}@example.test`)
    const second = await seededManager(`stage-two-${name}`, `stage-two-${name}@example.test`)
    const now = new Date().toISOString()
    await app.store.transaction(async tx => {
      for (const user of [first, second]) {
        await tx.identity.saveMembership({ teamId: project.teamId, userId: user.id, role: 'member', joinedAt: now })
        await tx.identity.saveProjectGrant({ projectId: project.id, userId: user.id, role: 'manager' })
      }
    })
    const task = await api(`/projects/${project.id}/tasks`, 'POST', { title: `分级验收 ${name}`, requestId: `stage-task-${name}` })
    const provision = await api(`/projects/${project.id}/tasks/${task.id}/workspaces`, 'POST', { name: `分级工作区 ${name}`, workerId, source: 'empty', requestId: `stage-space-${name}` })
    await eventually(() => api(`/workspaces/${provision.workspace.id}`), value => value.placements.some(p => p.workerId === workerId && p.status === 'ready'), 'actual Worker provisioned placement')
    const assignment = { workspaceId: provision.workspace.id, workerId, agentKey: 'test', modelId: 'test' }
    const assigned = await api(`/projects/${project.id}/tasks/${task.id}/assignment`, 'PUT', { version: provision.task.version, assignee: assignment })
    const todo = await api(`/projects/${project.id}/tasks/${task.id}`, 'PATCH', { version: assigned.version, status: 'todo' })
    await api(`/projects/${project.id}/tasks/${task.id}`, 'PATCH', { version: todo.version, status: 'in_progress' })
    const taskPath = `/projects/${project.id}/tasks/${task.id}`
    const login = async user => {
      const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
      assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: user.username, password: 'owned-stage-manager-password' } })).status(), 200, `manager ${user.username} logs in`)
      return context
    }
    const submitter = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    assert.equal((await submitter.request.post(`${origin}/api/auth/login`, { data: { login: email, password } })).status(), 200)
    const page = await submitter.newPage(); activePage = page; page.setDefaultTimeout(15000)
    page.on('pageerror', error => errors.push({ name, step, message: error.message }))
    page.on('console', message => { if (message.type() === 'error') errors.push({ name, step, message: message.text() }) })
    const surface = page.getByRole('region', { name: '任务运行' })
    step = `${name}: real Run succeeds under multi-stage policy`
    await page.goto(`${origin}/next/projects/${project.id}?task=${task.id}`)
    await surface.getByText('多阶段审查（首次执行前按项目默认值）', { exact: false }).waitFor()
    await surface.getByLabel('本次运行目标').fill('[test-agent:pause-ms=1500] staged-review-run')
    const launchPath = `/api/projects/${project.id}/tasks/${task.id}/launch`
    const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === launchPath)
    await surface.getByRole('button', { name: '启动新 Run' }).click()
    const received = await response; assert.equal(received.status(), 200, await received.text())
    const run = (await received.json()).run
    await eventually(() => api(`${taskPath}/runs`), value => value.items.some(r => r.id === run.id && r.status === 'succeeded'), 'actual staged Run succeeded', 45000)
    assert.equal((await api(taskPath)).status, 'in_progress', 'Run success cannot auto-complete a staged Task')
    assert.equal((await api(taskPath)).metadataJson.values.reviewPolicy, 'multi-stage', 'launch freezes the staged policy')
    await surface.getByRole('button', { name: '刷新运行状态' }).click()
    await surface.getByRole('heading', { name: '第 1 次执行：已成功' }).waitFor()
    step = `${name}: submitter files the staged review and cannot decide any stage`
    await surface.getByLabel('成果摘要').fill(`分级成果 ${name}`)
    await surface.getByLabel('证据引用（每行一条，最多 20 条）').fill(`journal:${run.sessionId}`)
    await surface.getByRole('button', { name: '提交人工审查' }).click()
    await surface.getByText('当前处于第 1/2 阶段', { exact: false }).waitFor()
    await surface.getByText('提交者本人不能审查自己的成果', { exact: false }).waitFor()
    assert.equal(await surface.getByRole('button', { name: '批准并进入下一阶段' }).count(), 0, 'submitter sees no decision button')
    const stage1 = (await api(`${taskPath}/runs/${run.id}/review`)).review
    assert.equal(stage1.stageIndex, 1); assert.equal(stage1.stageCount, 2)
    const barredDecisions = new Set()
    step = `${name}: stage 1 reviewer advances the chain and is barred from stage 2`
    const firstContext = await login(first)
    const firstPage = await firstContext.newPage(); activePage = firstPage; firstPage.setDefaultTimeout(15000)
    firstPage.on('pageerror', error => errors.push({ name, step, message: error.message }))
    firstPage.on('console', message => { if (message.type() === 'error' && !(barredDecisions.has(name) && message.text().includes('403'))) errors.push({ name, step, message: message.text() }) })
    const firstSurface = firstPage.getByRole('region', { name: '任务运行' })
    await firstPage.goto(`${origin}/next/projects/${project.id}?task=${task.id}`)
    await firstSurface.getByText('第 1/2 阶段审查决定', { exact: false }).waitFor()
    await firstSurface.getByRole('button', { name: '批准并进入下一阶段' }).click()
    await firstSurface.getByText('当前处于第 2/2 阶段', { exact: false }).waitFor()
    assert.equal((await api(taskPath)).status, 'in_review', 'stage 1 approval keeps the Task in review')
    const stage2 = (await api(`${taskPath}/runs/${run.id}/review`)).review
    assert.equal(stage2.id, (await api(taskPath)).currentReviewId)
    assert.equal(stage2.stageIndex, 2)
    barredDecisions.add(name)
    await firstSurface.getByRole('button', { name: '批准并完成' }).click()
    await firstSurface.getByRole('alert').first().waitFor()
    assert.equal((await api(taskPath)).status, 'in_review', 'stage 1 reviewer cannot decide stage 2')
    await firstPage.screenshot({ path: join(evidence, `${name}-stage1-approved-stage2-barred.png`), fullPage: true })
    step = `${name}: stage 2 reviewer finishes the chain`
    const secondContext = await login(second)
    const secondPage = await secondContext.newPage(); activePage = secondPage; secondPage.setDefaultTimeout(15000)
    secondPage.on('pageerror', error => errors.push({ name, step, message: error.message }))
    secondPage.on('console', message => { if (message.type() === 'error') errors.push({ name, step, message: message.text() }) })
    const secondSurface = secondPage.getByRole('region', { name: '任务运行' })
    await secondPage.goto(`${origin}/next/projects/${project.id}?task=${task.id}`)
    await secondSurface.getByText('第 2/2 阶段审查决定', { exact: false }).waitFor()
    await secondSurface.getByRole('button', { name: '批准并完成' }).click()
    await eventually(() => api(taskPath), value => value.status === 'done', 'stage 2 approval completes the Task')
    const activities = (await api(`${taskPath}/activity`)).items.map(item => item.payload?.action ?? null)
    assert.ok(activities.includes('review.submitted'))
    assert.ok(activities.includes('review.stage_advanced'))
    assert.equal((await api(taskPath)).currentReviewId, null)
    await secondPage.screenshot({ path: join(evidence, `${name}-stage2-done.png`), fullPage: true })
    for (const context of [submitter, firstContext, secondContext]) await context.close()
    checks.push(`${name}: multi-stage policy frozen at launch -> real Worker/Test Agent Run -> submitter files review -> stage-1 manager advances (stage 1/2) -> same manager barred from stage 2 -> stage-2 manager approves -> done with full activity chain`)
  }
  await browser.close(); browser = undefined
  await stopWorker()
  await app.close()
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ checks, errors, evidence }, null, 2))
} catch (error) {
  if (activePage) { try { await activePage.screenshot({ path: '/tmp/wemux-multi-stage-debug.png', fullPage: true }) } catch { /* page may be gone */ } }
  console.error(JSON.stringify({ failed: step, message: error instanceof Error ? error.message : String(error), checks, errors, evidence }, null, 2))
  process.exitCode = 1
  if (browser) await browser.close().catch(() => {})
  await stopWorker()
  await app.close().catch(() => {})
} finally { await rm(evidence, { recursive: true, force: true }).catch(() => {}) }
