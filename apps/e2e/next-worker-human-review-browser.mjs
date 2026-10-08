/** Actual Worker CLI/Test Agent -> two Runs -> human changes -> resubmission -> approval.
 * Only local account/password provisioning bypasses HTTP; all workflow writes use public APIs.
 * Required: WEMUX_NEXT_TEST_DIST=/tmp/... WEMUX_TEST_WORKER_CLI=/tmp/.../cli.js
 * plus PLAYWRIGHT_CORE_PATH and PLAYWRIGHT_CHROMIUM_PATH. Run with node --import tsx.
 * No Pi/Claude, paid model, synthetic Run/Review/Journal, or production data.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { createWemuxServer } from '../server/src/server.ts'
import { login, provisionAdministrator } from './session.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { ownedWorkerLaunch, removeOwnedServerDatabases } from './owned-worker-fixture.mjs'
import { launchAcceptanceBrowser, recordAcceptanceFailure } from '../web-next/tests/acceptance-runtime.mjs'

for (const key of ['WEMUX_NEXT_TEST_DIST', 'WEMUX_TEST_WORKER_CLI']) assert.ok(resolve(process.env[key] ?? '.').startsWith('/tmp/'), `${key} requires an owned /tmp build`)
const evidence = await mkdtemp(join(tmpdir(), 'wemux-next-worker-human-review-'))
const database = join(evidence, 'server.sqlite'), home = join(evidence, 'worker')
const email = 'worker-review-owner@example.test', reviewerEmail = 'worker-review-manager@example.test'
const password = randomBytes(24).toString('base64url')
const app = createWemuxServer({ databasePath: database, administratorEmails: [email], mail: {}, google: {}, webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST) })
const result = { passed: false, runtime: 'actual compiled Worker CLI + deterministic Test Agent; NOT Pi/Claude or multi-stage', checks: [], cycles: [], pageErrors: [], consoleErrors: [], failedResponses: [] }
const children = []
let browser, step = 'setup'
console.log(JSON.stringify({ evidence }))
function launchWorker(args, origin, purpose, enrollmentToken) {
  const owned = ownedWorkerLaunch(args, origin)
  // Inject only this fixture's token after ambient Worker settings are removed.
  if (enrollmentToken !== undefined) owned.env.WEMUX_ENROLLMENT_TOKEN = enrollmentToken
  const child = spawn(process.execPath, [resolve(process.env.WEMUX_TEST_WORKER_CLI), ...owned.args], { env: owned.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.setEncoding('utf8').on('data', text => { stdout += text })
  // Drain without persisting credential-bearing CLI output or invocation arguments.
  child.stderr.resume()
  const record = { child, purpose, pid: child.pid }
  record.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { record.code = code; record.signal = signal; resolve({ code, stdout }) }) })
  void record.done.catch(() => {})
  children.push(record)
  return record
}
async function eventually(read, accept, label, timeout = 45000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await delay(50) }
  throw Error(`Timed out: ${label}`)
}
function persisted(taskId) {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const rows = (sql, ...args) => db.prepare(sql).all(...args).map(row => JSON.parse(row.data))
    return {
      task: rows('SELECT data FROM tasks WHERE id=?', taskId)[0],
      runs: rows('SELECT data FROM task_runs WHERE task_id=? ORDER BY attempt', taskId),
      reviews: rows('SELECT data FROM review_requests WHERE task_id=? ORDER BY id', taskId),
      activity: rows('SELECT data FROM task_activity WHERE task_id=? ORDER BY seq', taskId),
    }
  } finally { db.close() }
}
async function post(session, origin, path, body) {
  const response = await fetch(`${origin}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: session.cookie, 'x-csrf-token': session.csrfToken }, body: JSON.stringify(body) })
  return { status: response.status, data: await response.json() }
}
async function pending(page, prefix) {
  return page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(sessionStorage.getItem(key))), prefix)
}
try {
  const origin = await app.listen(0)
  const owner = await provisionAdministrator({ store: app.store, baseUrl: origin, email, password })
  const api = owner.api
  await api('/bootstrap', 'POST', {})
  const manager = await seedLocalAccount(app.store, { username: reviewerEmail, email: reviewerEmail, password, administrator: false })
  const reviewer = await login(origin, reviewerEmail, password)
  const invitation = await api('/teams/default-team/invitations', 'POST', { email: reviewerEmail })
  await reviewer.api(`/team-invitations/${invitation.token}/accept`, 'POST', {})
  const enrollment = await api('/enrollment-tokens', 'POST', {})
  const registration = await launchWorker(['register', '--home', home, '--name', 'Owned Human Review Worker'], origin, 'register', enrollment.token).done
  assert.equal(registration.code, 0, 'owned CLI registration succeeds')
  const workerId = JSON.parse(registration.stdout).workerId
  launchWorker(['start', '--home', home], origin, 'start')
  await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities.some(c => c.agentKey === 'test' && c.availability.status === 'available'), 'Test Agent advertised by actual Worker')
  result.workerId = workerId
  browser = await launchAcceptanceBrowser()
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    step = `${name}: public setup`
    const project = await api('/projects', 'POST', { name: `真实人审闭环 ${name}`, teamId: 'default-team', requestId: `review-project-${name}` })
    assert.notEqual(project.ownerId, manager.id)
    await api(`/projects/${project.id}/grants`, 'POST', { userId: manager.id, role: 'manager' })
    assert.ok((await api(`/projects/${project.id}/grants`)).items.some(grant => grant.userId === manager.id && grant.role === 'manager'))
    assert.ok((await api('/teams/default-team/members')).items.some(member => member.user.id === manager.id && member.role === 'member'))
    await api(`/projects/${project.id}/review-policy`, 'PATCH', { reviewPolicy: 'human', version: project.reviewPolicyVersion ?? 1 })
    const task = await api(`/projects/${project.id}/tasks`, 'POST', { title: `真实人审闭环 ${name}`, requestId: `review-task-${name}` })
    const taskPath = `/projects/${project.id}/tasks/${task.id}`
    const provision = await api(`${taskPath}/workspaces`, 'POST', { name: `人审工作区 ${name}`, workerId, source: 'empty', requestId: `review-space-${name}` })
    const workspaceId = provision.workspace.id
    await eventually(() => api(`/workspaces/${workspaceId}`), value => value.placements.some(p => p.workerId === workerId && p.status === 'ready'), 'Worker-created ready placement')
    const assignment = { workspaceId, workerId, agentKey: 'test', modelId: 'test' }
    const assigned = await api(`${taskPath}/assignment`, 'PUT', { version: provision.task.version, assignee: assignment })
    const todo = await api(taskPath, 'PATCH', { version: assigned.version, status: 'todo' })
    await api(taskPath, 'PATCH', { version: todo.version, status: 'in_progress' })
    const newPage = async (identity, role) => {
      const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
      assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: identity, password } })).status(), 200)
      const page = await context.newPage(); page.setDefaultTimeout(15000)
      page.on('pageerror', () => result.pageErrors.push({ name, role, step }))
      page.on('console', message => {
        if (message.type() !== 'error') return
        const text = message.text()
        const expected = ['Failed to load resource: net::ERR_FAILED', 'Failed to load resource: the server responded with a status of 403 (Forbidden)']
        result.consoleErrors.push({ name, role, message: expected.includes(text) ? text : 'unexpected-console-error' })
      })
      page.on('response', response => {
        if (response.status() < 400) return
        const url = new URL(response.url())
        const expected = url.pathname === '/api/attention/pages' && url.searchParams.get('kind') === 'channel_dead_letter'
        result.failedResponses.push({ name, role, path: expected ? '/api/attention/pages' : 'unexpected-response', kind: expected ? 'channel_dead_letter' : null, status: response.status() })
      })
      return { context, page }
    }
    const author = await newPage(email, 'author'), human = await newPage(reviewerEmail, 'manager')
    const page = author.page, reviewerPage = human.page
    const surface = page.getByRole('region', { name: '任务运行' }), deciding = reviewerPage.getByRole('region', { name: '任务运行' })
    const taskUrl = `${origin}/next/projects/${project.id}?task=${task.id}`
    const cycle = { viewport: name, projectId: project.id, taskId: task.id, workspaceId, submitterId: project.ownerId, reviewerId: manager.id, attempts: [] }
    result.cycles.push(cycle)
    for (const attempt of [1, 2]) {
      step = `${name}: actual Run ${attempt}`
      await page.goto(taskUrl)
      const goal = `[test-agent:pause-ms=1500] human-review-${name}-attempt-${attempt}`
      await surface.getByLabel('本次运行目标').fill(goal)
      const launchResponse = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api${taskPath}/launch`)
      await surface.getByRole('button', { name: '启动新 Run', exact: true }).click()
      const launched = await launchResponse; assert.equal(launched.status(), 200)
      const launchReceipt = await launched.json(), run = launchReceipt.run
      assert.equal(run.attempt, attempt)
      await eventually(() => api(`${taskPath}/runs`), value => value.items.some(r => r.id === run.id && r.status === 'running'), 'real running Run')
      await eventually(() => api(`${taskPath}/runs`), value => value.items.some(r => r.id === run.id && r.status === 'succeeded'), 'real succeeded Run')
      const beforeReview = persisted(task.id)
      assert.equal(beforeReview.runs.length, attempt)
      assert.equal(beforeReview.task.status, 'in_progress', 'Run success does not finish Task')
      assert.equal(beforeReview.task.currentReviewId, null)
      assert.equal(beforeReview.task.metadataJson.values.reviewPolicy, 'human')
      assert.equal(beforeReview.task.metadataJson.values.reviewPolicyFrozen, true)
      const completedRun = beforeReview.runs.find(item => item.id === run.id)
      assert.deepEqual(completedRun.snapshot, assignment)
      assert.equal(completedRun.resultSummary, `Echo: ${goal}`)
      assert.equal(completedRun.failure, null)
      const lifecycle = beforeReview.activity.filter(item => item.payload?.runId === run.id)
      assert.deepEqual(lifecycle.map(item => [item.type, item.payload.status]), [['run.created', 'pending'], ['run.started', 'running'], ['run.finished', 'succeeded']])
      assert.ok(lifecycle.every(item => item.taskId === task.id && item.projectId === project.id))
      assert.equal(lifecycle.at(-1).payload.resultSummary, completedRun.resultSummary)
      const session = await api(`/sessions/${run.sessionId}`)
      assert.equal(session.taskId, task.id); assert.equal(session.projectId, project.id)
      assert.equal(session.runId, run.id); assert.equal(session.ownerId, project.ownerId)
      assert.equal(session.binding.agent.workerId, workerId); assert.equal(session.binding.agent.agentKey, 'test')
      assert.equal(session.binding.workspaceId, workspaceId)
      const journal = (await api(`/sessions/${run.sessionId}/events?fromSeq=1&limit=1000`)).events
      assert.ok(journal.length > 0 && journal.every(event => event.sessionId === session.id))
      assert.equal(new Set(journal.map(event => event.seq)).size, journal.length)
      const queued = journal.find(e => e.payload.kind === 'message.queued' && e.payload.commandId === completedRun.enqueueCommandId)
      assert.ok(queued); assert.equal(queued.payload.sentByAccountId, project.ownerId)
      assert.equal(queued.payload.content, goal)
      const started = journal.find(e => e.payload.kind === 'turn.started' && e.payload.messageId === queued.payload.messageId)
      assert.ok(started)
      assert.equal(completedRun.messageId, queued.payload.messageId)
      assert.equal(completedRun.turnId, started.payload.turnId)
      const finished = journal.filter(e => e.payload.kind === 'turn.finished' && e.payload.turnId === started.payload.turnId)
      assert.equal(finished.length, 1); assert.equal(finished[0].payload.outcome, 'completed')
      assert.ok(queued.seq < started.seq && started.seq < finished[0].seq)
      assert.equal(completedRun.finishedAt, finished[0].occurredAt)
      if (attempt === 2) {
        assert.notEqual(run.id, cycle.attempts[0].run.id); assert.notEqual(session.id, cycle.attempts[0].session.id)
        assert.deepEqual(beforeReview.reviews, [cycle.attempts[0].decision.data.review], 'first review remains closed through second execution')
        assert.deepEqual(beforeReview.runs[0], cycle.attempts[0].run, 'second execution cannot replace the first Run')
        assert.ok(Date.parse(completedRun.createdAt) >= Date.parse(cycle.attempts[0].decision.data.review.decidedAt), 'second Run starts after return to implementation')
      }
      await surface.getByRole('button', { name: '刷新运行状态' }).click()
      const runRow = surface.locator(`[data-run-id="${run.id}"]`)
      await runRow.getByRole('heading', { name: `第 ${attempt} 次执行：已成功` }).waitFor()
      await runRow.getByRole('button', { name: '查看关联会话' }).click()
      assert.equal(new URL(page.url()).searchParams.get('session'), session.id)
      const conversation = page.locator(`[data-conversation-session="${session.id}"]`)
      await conversation.getByRole('region', { name: '权威会话元数据' }).getByText('Agent：test', { exact: false }).waitFor()
      await conversation.getByRole('region', { name: '会话历史' }).getByText('Turn 已完成：', { exact: false }).waitFor()
      assert.equal(await conversation.getByRole('alert').count(), 0)
      await page.screenshot({ path: join(evidence, `${name}-${attempt}-run-session.png`), fullPage: true })

      // Lose each successful review response once. Reload + UI retry must preserve
      // the entire request and receipt and must not create a second domain write.
      const replayInBrowser = async ({ target, region, path, button, retry, confirmed, prefix, fill, phase }) => {
        const requests = []
        const handler = async route => {
          const body = route.request().postDataJSON(), response = await route.fetch(), data = await response.json()
          requests.push({ body, status: response.status(), data })
          if (requests.length === 1 && response.status() === 200) await route.abort('failed')
          else await route.fulfill({ response })
        }
        const matcher = url => url.pathname === `/api${path}`
        await target.route(matcher, handler)
        await fill()
        await region.getByRole('button', { name: button, exact: true }).click()
        await region.getByRole('button', { name: retry, exact: true }).waitFor()
        assert.equal(requests.length, 1); assert.equal(requests[0].status, 200)
        assert.deepEqual(await pending(target, prefix), [requests[0].body])
        const snapshot = persisted(task.id)
        await target.reload()
        await region.getByRole('button', { name: retry, exact: true }).waitFor()
        assert.equal(requests.length, 1, 'reload cannot automatically resubmit')
        assert.deepEqual(await pending(target, prefix), [requests[0].body])
        await region.getByRole('button', { name: retry, exact: true }).click()
        await region.getByText(confirmed, { exact: false }).waitFor()
        assert.equal(requests.length, 2); assert.equal(requests[1].status, 200)
        assert.deepEqual(requests[1], requests[0], 'exact body AND complete receipt replay')
        assert.deepEqual(persisted(task.id), snapshot, 'replay cannot change Task/Run/Review/activity')
        assert.deepEqual(await pending(target, prefix), [])
        await target.screenshot({ path: join(evidence, `${name}-${attempt}-${phase}.png`), fullPage: true })
        await target.unroute(matcher, handler)
        return requests
      }
      step = `${name}: submit actual Run ${attempt} for human review`
      const summary = `真实执行成果 ${name} 第 ${attempt} 次`, references = [`journal:${session.id}`, `run:${run.id}`]
      const submissions = await replayInBrowser({ target: page, region: surface, path: `${taskPath}/human-review-submission`, button: '提交人工审查', retry: '重试原人工审查请求', confirmed: '人工审查提交已确认', prefix: 'wemux.human-review:', phase: 'submitted', fill: async () => {
        await surface.getByLabel('成果摘要').fill(summary)
        await surface.getByLabel('证据引用（每行一条，最多 20 条）').fill(references.join('\n'))
      } })
      const submission = submissions[0], review = submission.data.review, submitted = persisted(task.id)
      assert.deepEqual(submission.body, { version: beforeReview.task.version, requestId: submission.body.requestId, runId: run.id, summary, evidence: references })
      assert.ok(submission.body.requestId)
      assert.equal(review.taskRunId, run.id); assert.equal(review.taskId, task.id); assert.equal(review.projectId, project.id)
      assert.equal(review.actor, project.ownerId); assert.equal(review.status, 'requested'); assert.equal(review.reviewer, null)
      assert.equal(review.decidedAt, null); assert.equal(review.closedAt, null)
      assert.equal(submitted.task.status, 'in_review'); assert.equal(submitted.task.currentReviewId, review.id)
      assert.equal(submitted.task.version, beforeReview.task.version + 1)
      assert.deepEqual(submitted.runs, beforeReview.runs)
      assert.deepEqual(submitted.reviews.find(item => item.id === review.id), review)
      if (attempt === 2) assert.notEqual(review.id, cycle.attempts[0].submission.data.review.id)
      const submissionActivity = submitted.activity.filter(item => item.payload?.action === 'review.submitted')
      assert.equal(submissionActivity.length, attempt)
      const activity = submissionActivity.at(-1)
      assert.equal(activity.actor, project.ownerId)
      assert.equal(activity.taskId, task.id); assert.equal(activity.projectId, project.id)
      assert.equal(activity.occurredAt, review.requestedAt)
      assert.deepEqual(activity.payload, { action: 'review.submitted', from: 'in_progress', to: 'in_review', runId: run.id, reviewId: review.id, summary, evidence: references })
      assert.equal(await surface.getByRole('button', { name: '批准并完成', exact: true }).count(), 0)

      step = `${name}: manager decision ${attempt}`
      await reviewerPage.goto(`${origin}/next/attention`)
      const group = reviewerPage.getByRole('region', { name: '任务人工审查', exact: true })
      const link = group.getByRole('link', { name: task.title, exact: true })
      await link.waitFor(); assert.equal(await link.getAttribute('href'), `/next/projects/${project.id}?task=${task.id}`)
      await link.click(); assert.equal(new URL(reviewerPage.url()).searchParams.get('task'), task.id)
      const status = attempt === 1 ? 'changes_requested' : 'approved', reason = `请补充 ${name} 的第二次执行验证`
      const self = await post(owner, origin, `${taskPath}/human-review-decision`, { version: submitted.task.version, requestId: `self-${name}-${attempt}`, reviewId: review.id, status, ...(attempt === 1 ? { reason } : {}) })
      assert.equal(self.status, 403); assert.equal(self.data.error.code, 'forbidden')
      assert.deepEqual(persisted(task.id), submitted, 'owner/submitter cannot decide own review')
      const decisions = await replayInBrowser({ target: reviewerPage, region: deciding, path: `${taskPath}/human-review-decision`, button: attempt === 1 ? '要求修改' : '批准并完成', retry: '重试原审查决定', confirmed: attempt === 1 ? '审查要求修改，Task 已回到进行中。' : '审查已批准，Task 已完成', prefix: 'wemux.human-decision:', phase: status, fill: async () => {
        if (attempt === 1) {
          assert.equal(await deciding.getByRole('button', { name: '要求修改', exact: true }).isDisabled(), true)
          await deciding.getByLabel('要求修改的理由', { exact: true }).fill(reason)
        }
      } })
      const decision = decisions[0], after = persisted(task.id), targetStatus = attempt === 1 ? 'in_progress' : 'done'
      assert.equal(decision.body.version, submitted.task.version); assert.equal(decision.body.reviewId, review.id); assert.equal(decision.body.status, status); assert.ok(decision.body.requestId)
      assert.equal(after.task.status, targetStatus); assert.equal(after.task.currentReviewId, null)
      assert.equal(after.task.version, submitted.task.version + 1)
      assert.deepEqual(decision.data.task, after.task)
      assert.deepEqual(decision.data.review, { ...review, status, reviewer: manager.id, decidedAt: decision.data.review.decidedAt, closedAt: decision.data.review.decidedAt })
      assert.ok(Number.isFinite(Date.parse(decision.data.review.decidedAt)))
      assert.deepEqual(after.reviews.find(item => item.id === review.id), decision.data.review)
      assert.deepEqual(after.runs, submitted.runs, 'human decision cannot modify or create Runs')
      const decidedActivity = after.activity.filter(item => item.payload?.action === 'review.decided')
      assert.equal(decidedActivity.length, attempt)
      const decided = decidedActivity.at(-1)
      assert.equal(decided.actor, manager.id); assert.equal(decided.taskId, task.id); assert.equal(decided.projectId, project.id)
      assert.equal(decided.occurredAt, decision.data.review.decidedAt)
      assert.deepEqual(decided.payload, { action: 'review.decided', from: 'in_review', to: targetStatus, runId: run.id, reviewId: review.id, reviewStatus: status, stageIndex: null, stageCount: null, reason: attempt === 1 ? reason : null })
      assert.deepEqual((await api(`${taskPath}/activity`)).items, after.activity)
      assert.equal((await api(taskPath)).status, targetStatus)
      await reviewerPage.goto(`${origin}/next/attention`)
      await group.getByText('已加载范围内暂无待办。', { exact: true }).waitFor()
      assert.equal(await group.getByRole('link').count(), 0)
      assert.equal(await reviewerPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
      await reviewerPage.screenshot({ path: join(evidence, `${name}-${attempt}-attention-cleared.png`), fullPage: true })
      cycle.attempts.push({ run: completedRun, session, journal, submission, submissionReplay: submissions[1], decision, decisionReplay: decisions[1], selfRejection: self, persisted: after })
      result.checks.push(`${name}: actual Run ${attempt}, linked Session/Journal, human submission exact replay, manager ${status} exact replay and consistent activity`)
    }
    // Old receipts remain historical, not commands to rewind the second cycle.
    const final = persisted(task.id)
    for (const attempt of cycle.attempts) {
      assert.deepEqual(await post(owner, origin, `${taskPath}/human-review-submission`, attempt.submission.body), { status: 200, data: attempt.submission.data })
      assert.deepEqual(await post(reviewer, origin, `${taskPath}/human-review-decision`, attempt.decision.body), { status: 200, data: attempt.decision.data })
      assert.deepEqual(persisted(task.id), final, 'historical replay cannot reopen a closed cycle')
    }
    assert.deepEqual(final.runs.map(run => run.status), ['succeeded', 'succeeded'])
    assert.equal(final.reviews.length, 2); assert.equal(final.task.status, 'done')
    assert.deepEqual(final.activity.filter(item => ['review.submitted', 'review.decided', 'completion.submitted'].includes(item.payload?.action)).map(item => [item.payload.action, item.payload.to]), [
      ['review.submitted', 'in_review'], ['review.decided', 'in_progress'], ['review.submitted', 'in_review'], ['review.decided', 'done'],
    ])
    result.checks.push(`${name}: two distinct Run/Session/Review identities; historical receipt replay leaves final done and all persisted rows unchanged`)
    await author.context.close(); await human.context.close()
  }
  assert.deepEqual(result.pageErrors, [])
  // 非管理员界面不再请求渠道死信页；SSE 流中断的 net::ERR_FAILED 是导航噪音，其余一律失败
  assert.deepEqual(result.failedResponses, [])
  assert.deepEqual(result.consoleErrors.filter(entry => entry.message !== 'Failed to load resource: net::ERR_FAILED'), [])
  assert.ok(result.consoleErrors.every(entry => entry.role === 'author' || entry.role === 'manager'))
  result.passed = true
} catch {
  // Thrown HTTP/Playwright errors and failure screenshots may contain credentials.
  recordAcceptanceFailure(result, step)
  console.error(JSON.stringify({ evidence, failure: result.failure }))
} finally {
  const cleanup = { browserClosed: false, workerStopped: false, serverClosed: false, workerHomeRemoved: false, serverDatabasesRemoved: false, processes: [], failures: [] }
  try { await browser?.close(); cleanup.browserClosed = true } catch { cleanup.failures.push('browser') }
  for (const record of children) {
    const { child } = record
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
    try { await record.done; assert.equal(record.code, 0) } catch { cleanup.failures.push(`worker ${record.purpose}`) }
    finally { clearTimeout(timer); cleanup.processes.push({ purpose: record.purpose, pid: record.pid, code: record.code, signal: record.signal }) }
  }
  cleanup.workerStopped = children.every(record => record.code === 0)
  try { await app.close(); cleanup.serverClosed = true } catch { cleanup.failures.push('server') }
  try { await rm(home, { recursive: true, force: true }); cleanup.workerHomeRemoved = true } catch { cleanup.failures.push('worker home') }
  try { await removeOwnedServerDatabases(database); cleanup.serverDatabasesRemoved = true } catch { cleanup.failures.push('server database') }
  if (cleanup.failures.length) result.passed = false
  await writeFile(join(evidence, 'cleanup.json'), JSON.stringify(cleanup, null, 2))
  await writeFile(join(evidence, 'checks.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ evidence, passed: result.passed, checks: result.checks, cleanup }))
  process.exitCode = result.passed ? 0 : 1
}
