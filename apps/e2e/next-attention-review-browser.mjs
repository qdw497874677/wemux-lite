// Real Server + Next navigation/decision acceptance, persisted synthetic successful Runs.
// WEMUX_NEXT_TEST_DIST=/tmp/<owned-build> node --import tsx apps/e2e/next-attention-review-browser.mjs
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createWemuxServer } from '../server/src/server.ts'
import { login as loginSession, provisionAdministrator } from './session.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { seedAttentionHumanReview } from '../server/src/test/fixtures/attention-human-reviews.ts'
import { launchAcceptanceBrowser } from '../web-next/tests/acceptance-runtime.mjs'

assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'))
const evidence = await mkdtemp(join(tmpdir(), 'wemux-next-attention-review-'))
const databasePath = join(evidence, 'server.sqlite')
const email = 'attention-owner@example.test', password = randomBytes(24).toString('base64url')
const app = createWemuxServer({ databasePath, administratorEmails: [email], mail: {}, google: {}, webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST) })
let browser, step = 'setup'
const checks = [], errors = [], consoleErrors = [], failedResponses = [], decisionEvidence = [], changesRequestedEvidence = []
try {
  const origin = await app.listen(0)
  const owner = await provisionAdministrator({ store: app.store, baseUrl: origin, email, password })
  await owner.api('/bootstrap', 'POST', {})
  const reviewer = await seedLocalAccount(app.store, { username: 'attention-reviewer', email: 'attention-reviewer@example.test', password })
  const reviewerHttp = await loginSession(origin, 'attention-reviewer', password)
  browser = await launchAcceptanceBrowser()
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    step = `${name}: fixture`
    const project = await owner.api('/projects', 'POST', { name: `待办审查 ${name}`, teamId: 'default-team', requestId: `attention-project-${name}` })
    await app.store.transaction(async tx => {
      await tx.identity.saveMembership({ teamId: project.teamId, userId: reviewer.id, role: 'member', joinedAt: new Date().toISOString() })
      await tx.identity.saveProjectGrant({ projectId: project.id, userId: reviewer.id, role: 'manager' })
    })
    const db = new DatabaseSync(databasePath)
    try { seedAttentionHumanReview(db, name, project.id, project.ownerId) } finally { db.close() }
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    const login = await context.request.post(`${origin}/api/auth/login`, { data: { login: 'attention-reviewer', password } })
    assert.equal(login.status(), 200)
    const page = await context.newPage(); page.setDefaultTimeout(12000)
    page.on('pageerror', () => errors.push(`${name}: page error`))
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(`${name}: ${message.text()}`) })
    page.on('response', response => { if (response.status() >= 400) failedResponses.push({ viewport: name, path: new URL(response.url()).pathname, kind: new URL(response.url()).searchParams.get('kind'), status: response.status() }) })
    const taskPath = `/api/projects/${project.id}/tasks/task-${name}`
    const decisionPath = `${taskPath}/human-review-decision`
    const decisions = []
    let loseConflict = true, loseSuccess = true
    await page.route(url => url.pathname === decisionPath, async route => {
      const body = route.request().postDataJSON(), response = await route.fetch(), data = await response.json()
      decisions.push({ body, status: response.status(), data })
      // A lost rejection is uncertain to the browser, just like a lost success.
      if (response.status() === 409 && loseConflict) { loseConflict = false; await route.abort('failed'); return }
      if (response.status() === 200 && loseSuccess) { loseSuccess = false; await route.abort('failed'); return }
      await route.fulfill({ response })
    })
    const pendingDecisions = () => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('wemux.human-decision:')).map(key => JSON.parse(sessionStorage.getItem(key))))
    step = `${name}: attention link`
    await page.goto(`${origin}/next/attention`)
    const group = page.getByRole('region', { name: '任务人工审查', exact: true })
    const link = group.getByRole('link', { name: `人工审查 ${name}`, exact: true })
    await link.waitFor()
    assert.equal(await link.getAttribute('href'), `/next/projects/${project.id}?task=task-${name}`)
    assert.equal(await group.getByRole('button', { name: '批准并完成' }).count(), 0)
    await page.screenshot({ path: join(evidence, `${name}-attention.png`), fullPage: true })
    await link.click()
    assert.equal(new URL(page.url()).searchParams.get('task'), `task-${name}`)
    step = `${name}: public authorized Task mutation after navigation`
    const surface = page.getByRole('region', { name: '任务运行' })
    const approve = surface.getByRole('button', { name: '批准并完成', exact: true })
    const retry = surface.getByRole('button', { name: '重试原审查决定', exact: true })
    const reconcile = surface.getByRole('button', { name: '放弃已拒绝决定并重新核对', exact: true })
    await approve.waitFor()
    await page.getByText('版本 1，', { exact: false }).waitFor()
    // Mutate through the actual owner-authorized HTTP API, never fixture SQL.
    const updated = await owner.api(taskPath.slice(4), 'PATCH', { version: 1, title: `人工审查并发更新 ${name}` })
    assert.equal(updated.version, 2)
    assert.equal(updated.status, 'in_review')
    await approve.click()
    await retry.waitFor()
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0].status, 409)
    assert.equal(decisions[0].data.error.code, 'version_conflict')
    assert.equal(decisions[0].body.reviewId, name)
    assert.equal(decisions[0].body.version, 1)
    assert.ok(decisions[0].body.requestId)
    assert.deepEqual(await pendingDecisions(), [decisions[0].body])
    assert.equal(await reconcile.count(), 0, 'lost response does not authorize retirement')
    assert.equal(await approve.isDisabled(), true)
    await page.screenshot({ path: join(evidence, `${name}-decision-uncertain.png`), fullPage: true })

    step = `${name}: reload and exact retry recover definitive CAS rejection`
    await page.reload()
    await retry.waitFor()
    assert.deepEqual(await pendingDecisions(), [decisions[0].body])
    assert.equal(decisions.length, 1, 'reload does not submit a decision')
    await retry.click()
    await reconcile.waitFor()
    assert.equal(decisions.length, 2)
    assert.equal(decisions[1].status, 409)
    assert.equal(decisions[1].data.error.code, 'version_conflict')
    assert.deepEqual(decisions[1].body, decisions[0].body)
    await surface.getByText('原审查决定因任务版本变化被明确拒绝。', { exact: false }).waitFor()
    await page.getByText('版本 2，', { exact: false }).waitFor()
    assert.deepEqual(await pendingDecisions(), [decisions[0].body], 'definitive rejection still requires deliberate retirement')
    assert.equal(await approve.isDisabled(), true)
    assert.equal((await owner.api(taskPath.slice(4))).status, 'in_review')
    assert.equal((await owner.api(`${taskPath.slice(4)}/activity`)).items.filter(item => item.payload?.action === 'review.decided').length, 0)
    await page.screenshot({ path: join(evidence, `${name}-decision-rejected.png`), fullPage: true })

    step = `${name}: explicit reconciliation gates on fresh Task Run and review reads`
    // Reload retains old DOM. Give both real reads unique rendered values so a
    // response-header event (or cached version 2) cannot satisfy this barrier.
    const refreshedTitle = `人工审查重新核对 ${name}`
    const refreshedSummary = `重新核对 Run 成果 ${name}`
    const refreshedTask = await owner.api(taskPath.slice(4), 'PATCH', { version: 2, title: refreshedTitle })
    assert.equal(refreshedTask.version, 3)
    assert.equal(refreshedTask.status, 'in_review')
    const fixtureDb = new DatabaseSync(databasePath)
    try {
      // Only the existing synthetic Run's display summary changes; status,
      // identity and review eligibility remain untouched. Responses are real.
      const result = fixtureDb.prepare("UPDATE task_runs SET data = json_set(data, '$.resultSummary', ?) WHERE id = ? AND task_id = ?").run(refreshedSummary, `run-${name}`, `task-${name}`)
      assert.equal(result.changes, 1)
    } finally { fixtureDb.close() }
    assert.equal(await page.getByRole('heading', { name: refreshedTitle, exact: true }).count(), 0)
    assert.equal(await surface.getByText(`结果：${refreshedSummary}`, { exact: true }).count(), 0)
    const held = new Set()
    const readPaths = [taskPath, `${taskPath}/runs`, `/api/projects/${project.id}/reviews`]
    const gates = new Map(readPaths.map(path => {
      let release, markRequested
      const promise = new Promise(resolve => { release = resolve })
      const requested = new Promise(resolve => { markRequested = resolve })
      return [path, { promise, release, requested, markRequested }]
    }))
    await page.route(url => gates.has(url.pathname), async route => {
      const path = new URL(route.request().url()).pathname
      if (route.request().method() === 'GET') { held.add(path); gates.get(path).markRequested(); await gates.get(path).promise }
      await route.continue()
    })
    try {
      const requests = readPaths.map(path => page.waitForRequest(request => new URL(request.url()).pathname === path && request.method() === 'GET'))
      await reconcile.click()
      await Promise.all(requests)
      await Promise.all([...gates.values()].map(gate => gate.requested))
      await surface.getByText('正在重新读取任务与 Run', { exact: false }).waitFor()
      assert.deepEqual([...held].sort(), [...readPaths].sort())
      assert.deepEqual(await pendingDecisions(), [])
      assert.equal(await approve.isDisabled(), true)
      for (const path of readPaths.slice(0, 2)) gates.get(path).release()
      await page.getByRole('heading', { name: refreshedTitle, exact: true }).waitFor()
      await page.getByText('版本 3，', { exact: false }).waitFor()
      await surface.locator(`[data-run-id="run-${name}"]`).getByText(`结果：${refreshedSummary}`, { exact: true }).waitFor()
      // Review is still held: both refreshed values must have reached React's
      // rendered UI before attributing the disabled action to the remaining read.
      assert.equal(await approve.isDisabled(), true, 'review refresh still pending after fresh Task and Run render')
      await page.screenshot({ path: join(evidence, `${name}-review-read-held.png`), fullPage: true })
      assert.equal(decisions.length, 2, 'reconciliation must not send a replacement decision')
    } finally { for (const gate of gates.values()) gate.release() }
    await surface.getByText('正在重新读取任务与 Run', { exact: false }).waitFor({ state: 'hidden' })
    await page.getByText('版本 3，', { exact: false }).waitFor()
    assert.equal(await approve.isEnabled(), true)
    assert.equal(decisions.length, 2, 'fresh reads alone are not a new decision')
    await page.screenshot({ path: join(evidence, `${name}-decision-reconciled.png`), fullPage: true })

    step = `${name}: deliberate new decision then lost-success exact replay`
    await approve.click()
    await retry.waitFor()
    assert.equal(decisions.length, 3)
    assert.equal(decisions[2].status, 200)
    assert.equal(decisions[2].body.version, 3)
    assert.equal(decisions[2].body.reviewId, name)
    assert.notEqual(decisions[2].body.requestId, decisions[0].body.requestId)
    assert.deepEqual(await pendingDecisions(), [decisions[2].body])
    assert.equal(await reconcile.count(), 0)
    assert.equal((await owner.api(taskPath.slice(4))).status, 'done')
    await page.reload()
    await retry.click()
    await surface.getByText('审查已批准，Task 已完成', { exact: false }).waitFor()
    assert.equal(decisions.length, 4)
    assert.equal(decisions[3].status, 200)
    assert.deepEqual(decisions[3].body, decisions[2].body)
    assert.deepEqual(decisions[3].data, decisions[2].data)
    assert.equal(decisions[3].data.review.reviewer, reviewer.id)
    assert.deepEqual(await pendingDecisions(), [])
    assert.equal((await owner.api(`${taskPath.slice(4)}/activity`)).items.filter(item => item.payload?.action === 'review.decided').length, 1)
    await page.screenshot({ path: join(evidence, `${name}-decision-approved.png`), fullPage: true })
    decisionEvidence.push({ viewport: name, decisionPath, statuses: decisions.map(item => item.status), requests: decisions.map(item => item.body), reconciliationReads: [...held], renderedBarrier: { taskVersion: refreshedTask.version, taskTitle: refreshedTitle, runId: `run-${name}`, runSummary: refreshedSummary, reviewHeld: true, approveDisabled: true } })
    checks.push(`${name}: Attention navigation; public PATCH CAS conflict; lost rejection retains exact identity across reload; explicit rejection and rendered Task/Run barrier while Review held; deliberate new decision; lost success exact replay with one decision activity`)
    step = `${name}: resolved review leaves Attention`
    await page.goto(`${origin}/next/attention`)
    await group.getByText('已加载范围内暂无待办。', { exact: true }).waitFor()
    assert.equal(await group.getByRole('link').count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    checks.push(`${name}: authorized Attention -> current Task review -> CAS/requestId approval -> absent from refreshed page`)

    step = `${name}: changes requested fixture and negative HTTP decisions`
    const changeId = `changes-${name}`
    const changeTaskPath = `/api/projects/${project.id}/tasks/task-${changeId}`
    const changeDecisionPath = `${changeTaskPath}/human-review-decision`
    const changeDb = new DatabaseSync(databasePath)
    try { seedAttentionHumanReview(changeDb, changeId, project.id, project.ownerId) } finally { changeDb.close() }
    // This fixture has no live Worker or ready Workspace; do not fabricate a
    // second execution or claim that resubmission after changes is covered.
    const persisted = () => {
      const db = new DatabaseSync(databasePath, { readOnly: true })
      try {
        return {
          task: JSON.parse(db.prepare('SELECT data FROM tasks WHERE id=?').get(`task-${changeId}`).data),
          review: JSON.parse(db.prepare('SELECT data FROM review_requests WHERE id=?').get(changeId).data),
          activity: db.prepare('SELECT data FROM task_activity WHERE task_id=? ORDER BY seq').all(`task-${changeId}`).map(row => JSON.parse(row.data)),
          runs: db.prepare('SELECT data FROM task_runs WHERE task_id=? ORDER BY attempt').all(`task-${changeId}`).map(row => JSON.parse(row.data)),
        }
      } finally { db.close() }
    }
    const postDecision = async (session, body) => {
      const response = await fetch(`${origin}${changeDecisionPath}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.csrfToken }, body: JSON.stringify(body) })
      return { status: response.status, data: await response.json() }
    }
    const reason = `请补充 ${name} 的复现步骤与验证证据`
    const intent = { version: 1, reviewId: changeId, status: 'changes_requested', reason }
    const before = persisted()
    const self = await postDecision(owner, { ...intent, requestId: `self-${changeId}` })
    assert.equal(self.status, 403)
    assert.equal(self.data.error.code, 'forbidden')
    assert.deepEqual(persisted(), before, 'submitter/owner cannot decide own review or mutate its records')
    const noReason = await postDecision(reviewerHttp, { ...intent, reason: '   ', requestId: `no-reason-${changeId}` })
    assert.equal(noReason.status, 400)
    assert.equal(noReason.data.error.code, 'invalid_request')
    assert.deepEqual(persisted(), before, 'blank reason cannot mutate review, Task, Run or activity')

    step = `${name}: changes requested Attention navigation and required reason`
    await page.reload()
    const changeLink = group.getByRole('link', { name: `人工审查 ${changeId}`, exact: true })
    await changeLink.waitFor()
    assert.equal(await changeLink.getAttribute('href'), `/next/projects/${project.id}?task=task-${changeId}`)
    await changeLink.click()
    assert.equal(new URL(page.url()).searchParams.get('task'), `task-${changeId}`)
    const requestChanges = surface.getByRole('button', { name: '要求修改', exact: true })
    await requestChanges.waitFor()
    assert.equal(await requestChanges.isDisabled(), true, 'reason is required before submitting')
    await surface.getByLabel('要求修改的理由', { exact: true }).fill('   ')
    assert.equal(await requestChanges.isDisabled(), true, 'whitespace is not a reason')
    await surface.getByLabel('要求修改的理由', { exact: true }).fill(reason)
    assert.equal(await requestChanges.isEnabled(), true)
    await page.screenshot({ path: join(evidence, `${name}-changes-reason.png`), fullPage: true })
    const decisionResponse = page.waitForResponse(response => new URL(response.url()).pathname === changeDecisionPath && response.request().method() === 'POST')
    await requestChanges.click()
    const changedResponse = await decisionResponse
    const changedBody = changedResponse.request().postDataJSON()
    const changedReceipt = await changedResponse.json()
    assert.equal(changedResponse.status(), 200)
    assert.deepEqual(changedBody, { ...intent, requestId: changedBody.requestId })
    assert.ok(changedBody.requestId)
    await surface.getByText('审查要求修改，Task 已回到进行中。', { exact: true }).waitFor()
    await page.getByText('版本 2，', { exact: false }).waitFor()
    await surface.getByRole('heading', { name: '人工审查决定', exact: true }).waitFor({ state: 'hidden' })
    assert.deepEqual(await pendingDecisions(), [])
    await page.screenshot({ path: join(evidence, `${name}-changes-decided.png`), fullPage: true })

    step = `${name}: changes requested persisted receipt activity and replay`
    const after = persisted()
    assert.equal(after.task.status, 'in_progress')
    assert.equal(after.task.version, before.task.version + 1)
    assert.equal(after.task.currentReviewId, null)
    assert.deepEqual(changedReceipt.task, after.task)
    assert.deepEqual(changedReceipt.review, after.review)
    assert.deepEqual(after.review, { ...before.review, status: 'changes_requested', reviewer: reviewer.id, decidedAt: after.review.decidedAt, closedAt: after.review.decidedAt })
    assert.ok(Number.isFinite(Date.parse(after.review.decidedAt)))
    assert.deepEqual(after.runs, before.runs, 'a human decision must not create or modify a Run')
    assert.equal(after.activity.length, 1)
    const activity = after.activity[0]
    assert.equal(activity.type, 'task.transitioned')
    assert.equal(activity.actor, reviewer.id)
    assert.equal(activity.taskId, after.task.id)
    assert.equal(activity.projectId, project.id)
    assert.equal(activity.occurredAt, after.review.decidedAt)
    assert.deepEqual(activity.payload, { action: 'review.decided', from: 'in_review', to: 'in_progress', runId: `run-${changeId}`, reviewId: changeId, reviewStatus: 'changes_requested', stageIndex: null, stageCount: null, reason })
    assert.deepEqual((await owner.api(`${changeTaskPath.slice(4)}/activity`)).items, after.activity)
    assert.equal((await owner.api(changeTaskPath.slice(4))).status, 'in_progress')
    const replay = await postDecision(reviewerHttp, changedBody)
    assert.equal(replay.status, 200)
    assert.deepEqual(replay.data, changedReceipt)
    assert.deepEqual(persisted(), after, 'exact replay creates no second activity')
    const stale = await postDecision(reviewerHttp, { ...changedBody, requestId: `stale-${changeId}` })
    assert.equal(stale.status, 409)
    assert.equal(stale.data.error.code, 'version_conflict')
    assert.deepEqual(persisted(), after, 'new request with old version cannot reopen the review')
    const closed = await postDecision(reviewerHttp, { ...changedBody, version: after.task.version, requestId: `closed-${changeId}` })
    assert.equal(closed.status, 409)
    assert.equal(closed.data.error.code, 'invalid_transition')
    assert.deepEqual(persisted(), after, 'even current version cannot decide a closed review again')

    step = `${name}: changes requested disappears from current approval Attention`
    await page.goto(`${origin}/next/attention`)
    await group.getByText('已加载范围内暂无待办。', { exact: true }).waitFor()
    assert.equal(await group.getByRole('link').count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    await page.screenshot({ path: join(evidence, `${name}-changes-attention-cleared.png`), fullPage: true })
    changesRequestedEvidence.push({ viewport: name, decisionPath: changeDecisionPath, request: changedBody, receipt: changedReceipt, persisted: after, negativeDecisions: { self: { status: self.status, code: self.data.error.code }, blankReason: { status: noReason.status, code: noReason.data.error.code }, stale: { status: stale.status, code: stale.data.error.code }, closed: { status: closed.status, code: closed.data.error.code } }, exactReplayStatus: replay.status, attentionEmpty: true, nextRunAndResubmission: 'not covered: fixture has no runnable Worker or ready Workspace' })
    checks.push(`${name}: Attention -> manager changes_requested with required reason -> in_progress, closed review and consistent persisted activity; submitter/blank reason rejected; exact replay and stale/closed review rejection without mutations; current approval Attention empty`)
    await context.close()
  }
  step = 'browser error accounting'
  assert.deepEqual(errors, [])
  // 非管理员界面不再请求渠道死信页（服务端仍仅管理员可读）；仅预期的 CAS 409 记账
  assert.deepEqual(failedResponses, decisionEvidence.flatMap(({ viewport, decisionPath }) => [
    { viewport, path: decisionPath, kind: null, status: 409 },
  ]))
  assert.deepEqual(consoleErrors, ['desktop', 'mobile'].flatMap(name => [
    `${name}: Failed to load resource: net::ERR_FAILED`,
    `${name}: Failed to load resource: the server responded with a status of 409 (Conflict)`,
    `${name}: Failed to load resource: net::ERR_FAILED`,
  ]))
  await writeFile(join(evidence, 'checks.json'), JSON.stringify({ passed: true, checks, errors, consoleErrors, failedResponses, decisionEvidence, changesRequestedEvidence }, null, 2))
  console.log(JSON.stringify({ evidence, checks }))
} catch (cause) {
  await writeFile(join(evidence, 'checks.json'), JSON.stringify({ passed: false, step, failure: String(cause), checks, errors, consoleErrors, failedResponses, decisionEvidence, changesRequestedEvidence }, null, 2))
  console.error(JSON.stringify({ evidence, failedStep: step }))
  process.exitCode = 1
} finally {
  const cleanup = { browserClosed: false, serverClosed: false, databaseRetainedForEvidence: databasePath }
  try { await browser?.close(); cleanup.browserClosed = true }
  finally {
    try { await app.close(); cleanup.serverClosed = true }
    finally { await writeFile(join(evidence, 'cleanup.json'), JSON.stringify(cleanup, null, 2)) }
  }
}
