// Isolated real Server + Next Chromium Run acceptance, synthetic online inventory (no Worker execution).
// WEMUX_NEXT_TEST_DIST=/tmp/wemux-next-run-dist node --import tsx apps/e2e/next-task-run-browser.mjs
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createWemuxServer } from '../server/src/server.ts'
import { provisionAdministrator } from './session.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { saveRunProjection } from '../server/src/application/run-projection.ts'

assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'), 'build must be in owned temp directory')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')
const evidence = await mkdtemp(join(tmpdir(), 'wemux-next-task-run-browser-'))
const email = 'run-browser-owner@example.test', password = 'synthetic-run-browser-password'
const app = createWemuxServer({ databasePath: join(evidence, 'server.sqlite'), administratorEmails: [email], mail: {}, google: {}, webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST) })
let browser, step = 'setup'
const checks = [], pageErrors = [], consoleErrors = []
try {
  const origin = await app.listen(0)
  const owner = await provisionAdministrator({ store: app.store, baseUrl: origin, email, password })
  await owner.api('/bootstrap', 'POST', {})
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    step = `${name}: fixture`
    const project = await owner.api('/projects', 'POST', { name: `Run 验收 ${name}`, teamId: 'default-team', requestId: `run-project-${name}` })
    const task = await owner.api(`/projects/${project.id}/tasks`, 'POST', { title: `Run 任务 ${name}`, requestId: `run-task-${name}` })
    // The Worker inventory here is only a synthetic execution environment; no paid model is started.
    const workerId = `run-worker-${name}`, assignment = { workspaceId: '', workerId, agentKey: 'synthetic', modelId: 'model' }
    await app.store.transaction(tx => tx.resources.saveWorker({ id: workerId, teamId: project.teamId, ownerId: project.ownerId, name: `合成节点 ${name}`, shareScope: 'team', connectionState: 'online', version: '1', platform: 'linux', lastSeenAt: new Date().toISOString(), capabilities: [{ agentKey: 'synthetic', displayName: '合成执行者', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model', displayName: '合成模型', source: 'configured' }] }] }))
    const created = await owner.api(`/projects/${project.id}/tasks/${task.id}/workspaces`, 'POST', { name: `Run 工作区 ${name}`, workerId, source: 'empty', requestId: `run-space-${name}` })
    assignment.workspaceId = created.workspace.id
    await app.store.transaction(tx => tx.resources.saveWorkspace({ ...created.workspace, status: 'ready' }))
    await owner.api(`/projects/${project.id}/tasks/${task.id}/assignment`, 'PUT', { version: created.task.version, assignee: assignment })
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    const loggedIn = await context.request.post(`${origin}/api/auth/login`, { data: { login: email, password } }); assert.equal(loggedIn.status(), 200)
    const page = await context.newPage(); page.setDefaultTimeout(12000)
    page.on('pageerror', err => pageErrors.push(`${name}: ${err.message}`))
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(`${name}: ${msg.text()}`) })
    const launchPath = `/api/projects/${project.id}/tasks/${task.id}/launch`
    const cancelPath = `/api/projects/${project.id}/tasks/${task.id}/runs/`
    const launches = [], cancellations = []
    let loseLaunch = true, loseCancel = true
    await page.route(url => url.pathname === launchPath || url.pathname.startsWith(cancelPath) && url.pathname.endsWith('/cancel'), async route => {
      const isLaunch = new URL(route.request().url()).pathname === launchPath
      const body = route.request().postDataJSON(), response = await route.fetch(), data = await response.json()
      ;(isLaunch ? launches : cancellations).push({ body, status: response.status(), data })
      if (isLaunch && loseLaunch) { loseLaunch = false; await route.abort('failed'); return }
      if (!isLaunch && loseCancel) { loseCancel = false; await route.abort('failed'); return }
      await route.fulfill({ response })
    })
    const surface = page.getByRole('region', { name: '任务运行' })
    step = `${name}: initial launch and lost reply`
    await page.goto(`${origin}/next/projects/${project.id}?task=${task.id}`)
    const launch = surface.getByRole('button', { name: '启动新 Run' })
    await launch.waitFor(); await surface.getByLabel('本次运行目标').fill(`执行验收 ${name}`)
    await launch.click()
    const retry = surface.getByRole('button', { name: '重试原 Run 请求' })
    await retry.waitFor()
    assert.equal(launches.length, 1); assert.equal(launches[0].status, 200)
    const first = launches[0].data.run
    assert.equal((await owner.api(`/projects/${project.id}/tasks/${task.id}/runs`)).items.length, 1)
    assert.deepEqual((await owner.api(`/projects/${project.id}/tasks/${task.id}/sessions`)).items.map(session => session.id), [first.sessionId])
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('wemux.task-run:')).length), 1)
    await page.screenshot({ path: join(evidence, `${name}-run-pending.png`), fullPage: true })
    step = `${name}: refresh and exact replay`
    await page.reload(); await retry.click()
    await surface.getByText('已确认 Run', { exact: false }).waitFor()
    assert.deepEqual(launches[1].body, launches[0].body)
    assert.equal(launches[1].data.run.id, first.id)
    assert.equal((await owner.api(`/projects/${project.id}/tasks/${task.id}/runs`)).items.length, 1)
    assert.deepEqual((await owner.api(`/projects/${project.id}/tasks/${task.id}/sessions`)).items.map(session => session.id), [first.sessionId])
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('wemux.task-run:')).length), 0)
    checks.push(`${name}: exact Run replay after lost response, one Run/Session`)
    step = `${name}: cancel lost reply and refresh`
    const cancel = surface.getByRole('button', { name: '取消本次 Run' })
    await cancel.waitFor(); await cancel.click()
    await surface.getByRole('alert').waitFor()
    assert.equal(cancellations.length, 1); assert.equal(cancellations[0].status, 200)
    assert.equal(cancellations[0].body.runId, first.id)
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('wemux.run-cancel:')).length), 1)
    await page.reload(); await surface.getByRole('button', { name: '取消本次 Run' }).click()
    await surface.getByText('取消请求已受理', { exact: false }).waitFor()
    assert.equal(cancellations.length, 2); assert.deepEqual(cancellations[1].body, cancellations[0].body)
    assert.equal(cancellations[1].data.run.id, first.id)
    assert.equal(cancellations[1].data.run.sessionId, first.sessionId)
    assert.deepEqual(cancellations[1].data.cancelCommandIds, cancellations[0].data.cancelCommandIds)
    assert.equal((await owner.api(`/projects/${project.id}/tasks/${task.id}/runs`)).items.length, 1)
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('wemux.run-cancel:')).length), 0)
    await page.screenshot({ path: join(evidence, `${name}-run-cancelling.png`), fullPage: true })
    checks.push(`${name}: exact cancellation replay after lost response`)
    step = `${name}: linked Session navigation`
    await surface.getByRole('button', { name: '查看关联会话' }).click()
    assert.equal(new URL(page.url()).searchParams.get('session'), first.sessionId)
    await page.locator(`[data-session-id="${first.sessionId}"]`).waitFor()
    await page.locator(`[data-conversation-session="${first.sessionId}"]`).waitFor()
    await page.getByRole('region', { name: '权威会话元数据' }).waitFor()
    checks.push(`${name}: Run navigates to loaded linked Session`)
    step = `${name}: no-review explicit completion`
    const completionTask = await owner.api(`/projects/${project.id}/tasks`, 'POST', { title: `显式完成 ${name}`, requestId: `complete-task-${name}` })
    const completionWorkspace = await owner.api(`/projects/${project.id}/tasks/${completionTask.id}/workspaces`, 'POST', { name: `完成工作区 ${name}`, workerId, source: 'empty', requestId: `complete-space-${name}` })
    await app.store.transaction(tx => tx.resources.saveWorkspace({ ...completionWorkspace.workspace, status: 'ready' }))
    const completeAssignment = { ...assignment, workspaceId: completionWorkspace.workspace.id }
    const assigned = await owner.api(`/projects/${project.id}/tasks/${completionTask.id}/assignment`, 'PUT', { version: completionWorkspace.task.version, assignee: completeAssignment })
    const todo = await owner.api(`/projects/${project.id}/tasks/${completionTask.id}`, 'PATCH', { version: assigned.version, status: 'todo' })
    await owner.api(`/projects/${project.id}/tasks/${completionTask.id}`, 'PATCH', { version: todo.version, status: 'in_progress' })
    await page.goto(`${origin}/next/projects/${project.id}?task=${completionTask.id}`)
    const completing = page.getByRole('region', { name: '任务运行' })
    await completing.getByLabel('本次运行目标').fill('无审查完成验收')
    await completing.getByRole('button', { name: '启动新 Run' }).click()
    await completing.getByText('已确认 Run', { exact: false }).waitFor()
    const completionRuns = await owner.api(`/projects/${project.id}/tasks/${completionTask.id}/runs`)
    assert.equal(completionRuns.items.length, 1)
    const completionRun = completionRuns.items[0]
    assert.equal((await owner.api(`/projects/${project.id}/tasks/${completionTask.id}`)).status, 'in_progress', 'Run launch does not auto-complete Task')
    // Synthetic projection only: exercise the real completion HTTP/UI with a
    // successful Run fact; this harness does not execute a Worker or paid model.
    await app.store.transaction(tx => saveRunProjection(tx, { ...completionRun, status: 'succeeded', finishedAt: new Date().toISOString() }, 'run.finished'))
    assert.equal((await owner.api(`/projects/${project.id}/tasks/${completionTask.id}`)).status, 'in_progress', 'Run success does not auto-complete Task')
    await completing.getByRole('button', { name: '刷新运行状态' }).click()
    await completing.getByRole('button', { name: '提交完成' }).waitFor()
    await completing.getByLabel('成果摘要').fill(`完成验收 ${name}`)
    await completing.getByLabel('证据引用（每行一条，最多 20 条）').fill('synthetic:evidence')
    await completing.getByRole('button', { name: '提交完成' }).click()
    await completing.getByText('已提交完成', { exact: false }).waitFor()
    const completedTask = await owner.api(`/projects/${project.id}/tasks/${completionTask.id}`)
    assert.equal(completedTask.status, 'done')
    assert.ok((await owner.api(`/projects/${project.id}/tasks/${completionTask.id}/activity`)).items.some(item => item.payload?.action === 'completion.submitted' && item.payload.summary === `完成验收 ${name}` && item.payload.evidence?.[0] === 'synthetic:evidence'))
    await page.screenshot({ path: join(evidence, `${name}-explicit-completion.png`), fullPage: true })
    checks.push(`${name}: first Run policy snapshot refresh, no automatic completion, explicit summary/evidence submission and activity`)
    step = `${name}: human review with lost response and exact replay`
    await owner.api(`/projects/${project.id}/review-policy`, 'PATCH', { reviewPolicy: 'human', version: project.reviewPolicyVersion ?? 1 })
    const reviewTask = await owner.api(`/projects/${project.id}/tasks`, 'POST', { title: `人工审查 ${name}`, requestId: `human-task-${name}` })
    const reviewWorkspace = await owner.api(`/projects/${project.id}/tasks/${reviewTask.id}/workspaces`, 'POST', { name: `审查工作区 ${name}`, workerId, source: 'empty', requestId: `human-space-${name}` })
    await app.store.transaction(tx => tx.resources.saveWorkspace({ ...reviewWorkspace.workspace, status: 'ready' }))
    const reviewAssignment = await owner.api(`/projects/${project.id}/tasks/${reviewTask.id}/assignment`, 'PUT', { version: reviewWorkspace.task.version, assignee: { ...assignment, workspaceId: reviewWorkspace.workspace.id } })
    const reviewTodo = await owner.api(`/projects/${project.id}/tasks/${reviewTask.id}`, 'PATCH', { version: reviewAssignment.version, status: 'todo' })
    await owner.api(`/projects/${project.id}/tasks/${reviewTask.id}`, 'PATCH', { version: reviewTodo.version, status: 'in_progress' })
    await page.goto(`${origin}/next/projects/${project.id}?task=${reviewTask.id}`)
    const reviewing = page.getByRole('region', { name: '任务运行' })
    await reviewing.getByLabel('本次运行目标').fill('合成投影的人工审查提交验收')
    await reviewing.getByRole('button', { name: '启动新 Run' }).click()
    await reviewing.getByText('已确认 Run', { exact: false }).waitFor()
    const reviewRuns = await owner.api(`/projects/${project.id}/tasks/${reviewTask.id}/runs`)
    assert.equal(reviewRuns.items.length, 1)
    const reviewRun = reviewRuns.items[0]
    assert.equal((await owner.api(`/projects/${project.id}/tasks/${reviewTask.id}`)).metadataJson.values.reviewPolicy, 'human')
    // Only a synthetic successful projection. A separate real Worker browser fixture covers actual Run execution.
    await app.store.transaction(tx => saveRunProjection(tx, { ...reviewRun, status: 'succeeded', finishedAt: new Date().toISOString() }, 'run.finished'))
    await reviewing.getByRole('button', { name: '刷新运行状态' }).click()
    const submit = reviewing.getByRole('button', { name: '提交人工审查' })
    await submit.waitFor()
    const reviewPath = `/api/projects/${project.id}/tasks/${reviewTask.id}/human-review-submission`
    let loseReview = true
    const submissions = []
    await page.route(url => url.pathname === reviewPath, async route => {
      const body = route.request().postDataJSON(), response = await route.fetch(), data = await response.json()
      submissions.push({ body, status: response.status(), data })
      if (loseReview && response.status() === 200) { loseReview = false; await route.abort('failed'); return }
      await route.fulfill({ response })
    })
    await reviewing.getByLabel('成果摘要').fill(`审查成果 ${name}`)
    await reviewing.getByLabel('证据引用（每行一条，最多 20 条）').fill('synthetic:review')
    const staleTask = await owner.api(`/projects/${project.id}/tasks/${reviewTask.id}`)
    await owner.api(`/projects/${project.id}/tasks/${reviewTask.id}`, 'PATCH', { version: staleTask.version, title: `人工审查新标题 ${name}` })
    await submit.click()
    const reconcile = reviewing.getByRole('button', { name: '放弃已拒绝请求并重新核对' })
    await reconcile.waitFor()
    assert.equal(submissions.length, 1); assert.equal(submissions[0].status, 409)
    assert.equal((await owner.api(`/projects/${project.id}/tasks/${reviewTask.id}`)).status, 'in_progress')
    // Preload the newer version before retirement, then delay BOTH requested reads.
    await reviewing.getByRole('button', { name: '刷新运行状态' }).click()
    await page.getByText(`版本 ${staleTask.version + 1}，`, { exact: false }).waitFor()
    await page.waitForTimeout(100)
    const heldPaths = []
    let releaseReads
    const readsHeld = new Promise(resolve => { releaseReads = resolve })
    await page.route(url => url.pathname === `/api/projects/${project.id}/tasks/${reviewTask.id}` || url.pathname === `/api/projects/${project.id}/tasks/${reviewTask.id}/runs`, async route => {
      if (route.request().method() === 'GET') { heldPaths.push(route.request().url()); await readsHeld }
      await route.continue()
    })
    await reconcile.click()
    await reviewing.getByText('正在重新读取任务与 Run', { exact: false }).waitFor()
    assert.equal(await submit.count(), 0, `no stale review form while authoritative Task refresh is pending: ${await reviewing.innerText()}`)
    await page.waitForTimeout(250)
    assert.equal(await submit.count(), 0, `preloaded Task and Run must not bypass requested refresh; intercepted: ${JSON.stringify(heldPaths)}; panel: ${await reviewing.innerText()}`)
    assert.equal(submissions.length, 1, 'no new submission before both reads finish')
    releaseReads()
    await submit.waitFor()
    await reviewing.getByLabel('成果摘要').fill(`审查成果 ${name}`)
    await reviewing.getByLabel('证据引用（每行一条，最多 20 条）').fill('synthetic:review')
    await submit.click()
    await reviewing.getByRole('button', { name: '重试原人工审查请求' }).waitFor()
    assert.equal(submissions.length, 2); assert.equal(submissions[1].status, 200)
    assert.notEqual(submissions[1].body.requestId, submissions[0].body.requestId)
    assert.ok(submissions[1].body.version > submissions[0].body.version)
    assert.equal((await owner.api(`/projects/${project.id}/tasks/${reviewTask.id}`)).status, 'in_review')
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('wemux.human-review:')).length), 1)
    await page.reload()
    await reviewing.getByRole('button', { name: '重试原人工审查请求' }).click()
    await reviewing.getByText('人工审查提交已确认', { exact: false }).waitFor()
    assert.equal(submissions.length, 3); assert.equal(submissions[2].status, 200)
    assert.deepEqual(submissions[2].body, submissions[1].body)
    assert.equal(submissions[2].data.review.id, submissions[1].data.review.id)
    assert.equal(submissions[2].data.review.reviewer, null)
    assert.equal((await owner.api(`/projects/${project.id}/tasks/${reviewTask.id}`)).status, 'in_review')
    assert.equal((await owner.api(`/projects/${project.id}/tasks/${reviewTask.id}/activity`)).items.filter(item => item.payload?.action === 'review.submitted').length, 1)
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('wemux.human-review:')).length), 0)
    await reviewing.getByText(`提交者：${submissions[1].data.review.actor}；Run：${submissions[1].data.review.taskRunId}`, { exact: false }).waitFor()
    assert.equal(await reviewing.getByRole('button', { name: '批准并完成' }).count(), 0, 'submitter cannot approve their own review after reviews load')
    assert.equal(await reviewing.getByRole('button', { name: '要求修改' }).count(), 0, 'submitter cannot request changes on their own review after reviews load')
    const reviewerEmail = `run-reviewer-${name}@example.test`, reviewerPassword = 'reviewer-fixture-password'
    const reviewerUser = await seedLocalAccount(app.store, { username: reviewerEmail, email: reviewerEmail, password: reviewerPassword, administrator: false })
    await app.store.transaction(async tx => {
      await tx.identity.saveMembership({ teamId: project.teamId, userId: reviewerUser.id, role: 'member', joinedAt: new Date().toISOString() })
      await tx.identity.saveProjectGrant({ projectId: project.id, userId: reviewerUser.id, role: 'manager' })
    })
    const reviewerContext = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    const reviewerLogin = await reviewerContext.request.post(`${origin}/api/auth/login`, { data: { login: reviewerEmail, password: reviewerPassword } }); assert.equal(reviewerLogin.status(), 200)
    const reviewerPage = await reviewerContext.newPage(); reviewerPage.setDefaultTimeout(12000)
    reviewerPage.on('pageerror', err => pageErrors.push(`${name}: ${err.message}`))
    reviewerPage.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(`${name}: ${msg.text()}`) })
    const decisionPath = `/api/projects/${project.id}/tasks/${reviewTask.id}/human-review-decision`, decisions = []
    let loseDecision = true
    await reviewerPage.route(url => url.pathname === decisionPath, async route => {
      const body = route.request().postDataJSON(), response = await route.fetch(), data = await response.json()
      decisions.push({ body, status: response.status(), data })
      if (loseDecision && response.status() === 200) { loseDecision = false; await route.abort('failed'); return }
      await route.fulfill({ response })
    })
    await reviewerPage.goto(`${origin}/next/projects/${project.id}?task=${reviewTask.id}`)
    const deciding = reviewerPage.getByRole('region', { name: '任务运行' })
    const approve = deciding.getByRole('button', { name: '批准并完成' })
    await approve.waitFor(); await approve.click()
    await deciding.getByRole('button', { name: '重试原审查决定' }).waitFor()
    assert.equal(decisions.length, 1); assert.equal(decisions[0].status, 200)
    assert.equal((await owner.api(`/projects/${project.id}/tasks/${reviewTask.id}`)).status, 'done')
    assert.equal(await reviewerPage.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('wemux.human-decision:')).length), 1)
    await reviewerPage.screenshot({ path: join(evidence, `${name}-human-decision-pending.png`), fullPage: true })
    await reviewerPage.reload()
    await deciding.getByRole('button', { name: '重试原审查决定' }).click()
    await deciding.getByText('审查已批准，Task 已完成', { exact: false }).waitFor()
    assert.equal(decisions.length, 2); assert.deepEqual(decisions[1].body, decisions[0].body)
    assert.equal(decisions[1].data.review.id, decisions[0].data.review.id)
    assert.equal(decisions[1].data.review.reviewer, reviewerUser.id)
    assert.equal(await reviewerPage.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('wemux.human-decision:')).length), 0)
    assert.equal((await owner.api(`/projects/${project.id}/tasks/${reviewTask.id}/activity`)).items.filter(item => item.payload?.action === 'review.decided').length, 1)
    await reviewerPage.screenshot({ path: join(evidence, `${name}-human-review-approved.png`), fullPage: true })
    await page.screenshot({ path: join(evidence, `${name}-human-review-pending.png`), fullPage: true })
    checks.push(`${name}: stale CAS review reconfirmation and exact lost-response submission replay; separate manager decides, exact lost-decision replay and one approval`)
    await reviewerContext.close()
    await context.close()
  }
  assert.deepEqual(pageErrors, [])
  // Four deliberate aborts and one expected stale-CAS 409 per viewport are exact fixture fault injections.
  assert.deepEqual(consoleErrors, ['desktop', 'mobile'].flatMap(name => [
    `${name}: Failed to load resource: net::ERR_FAILED`,
    `${name}: Failed to load resource: net::ERR_FAILED`,
    `${name}: Failed to load resource: the server responded with a status of 409 (Conflict)`,
    `${name}: Failed to load resource: net::ERR_FAILED`,
    `${name}: Failed to load resource: net::ERR_FAILED`,
  ]))
  await writeFile(join(evidence, 'checks.json'), JSON.stringify({ checks, pageErrors, consoleErrors }, null, 2))
  console.log(JSON.stringify({ evidence, checks }))
} catch (error) {
  console.error(JSON.stringify({ evidence, step, error: String(error), pageErrors, consoleErrors }))
  throw error
} finally { await browser?.close(); await app.close(); if (process.env.WEMUX_KEEP_E2E !== '1') await rm(evidence, { recursive: true, force: true }) }
