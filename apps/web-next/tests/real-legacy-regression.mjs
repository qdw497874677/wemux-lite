// Existing-instance acceptance only. Explicit WEMUX_LEGACY_TEST_WRITE=1 permits
// one retained Ticket01 Task/Session using the actually advertised Test Agent.
// Binding preflight is not atomic: a rejected bind retains the new Task for manual
// recovery, with exact IDs in private evidence. Never auto-clean or try another target.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readAcceptanceCredentials } from './real-instance-credentials.mjs'
import { expectedAcceptanceAbort } from './acceptance-diagnostics.mjs'
import { observeAcceptanceAuthDiagnostics } from './acceptance-auth-diagnostics.mjs'
import { observeAcceptanceNavigation } from './acceptance-navigation.mjs'
import { observeFetchLifecycle, acceptanceRequestKind } from './acceptance-fetch-lifecycle.mjs'
import { findSafeTestAgentTarget, createRetainedTestTask, readLegacyPublicResponse } from './legacy-test-target.mjs'
import { browserConfiguration, launchAcceptanceBrowser, recordAcceptanceFailure, finishAcceptance, registerCurrentLoginCleanup } from './acceptance-runtime.mjs'
const evidence = process.env.WEMUX_NEXT_EVIDENCE ?? '/tmp/wemux-next-legacy-regression'
const result = { passed: false, checks: [], diagnostics: [], lifecycle: [], retained: null }
let browser, step = 'initialize'
const cleanupLogins = []
const fingerprint = value => createHash('sha256').update(value).digest('hex').slice(0, 12)
try {
  browserConfiguration()
  assert.ok(!(process.env.WEMUX_LEGACY_RETAINED_FILE && process.env.WEMUX_LEGACY_TEST_WRITE === '1'), 'retained readback cannot create another Task/Session')
  const credentials = await readAcceptanceCredentials()
  const base = new URL(process.env.WEMUX_NEXT_BASE_URL).origin
  browser = await launchAcceptanceBrowser()
  let retained
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile })
    const page = await context.newPage()
    const navigations = new WeakMap()
    // This new non-persistent browser context has no login. Replace the frozen
    // identity at each boundary; stage labels are not authentication evidence.
    let identity = Object.freeze({ confirmed: true, reason: 'anonymous' })
    let sequence = 0, pageCount = 0
    const navigate = (page, method, url) => navigations.get(page).navigate(method, url)
    const observe = async page => {
      const pageId = ++pageCount
      const trace = fields => result.lifecycle.push({ mobile, pageId, ...fields, sequence: ++sequence })
      const navigation = observeAcceptanceNavigation(page, trace)
      navigations.set(page, navigation)
      if (process.env.WEMUX_ACCEPTANCE_FETCH_DIAGNOSTICS === '1') await observeFetchLifecycle(page, fields => trace({ source: 'document', ...fields }))
      const times = new WeakMap(), requestIds = new WeakMap()
      let requestCount = 0
      const startedAt = Date.now()
      const isFavicon = request => new URL(request.url()).pathname === '/favicon.svg'
      page.on('request', request => {
        times.set(request, Date.now() - startedAt)
        requestIds.set(request, ++requestCount)
        if (process.env.WEMUX_ACCEPTANCE_FETCH_DIAGNOSTICS === '1') trace({ event: 'request-start', requestId: requestIds.get(request), epoch: navigation.startEpoch(request), requestKind: acceptanceRequestKind(new URL(request.url()).pathname) })
        if (isFavicon(request)) trace({ event: 'favicon-request', requestId: requestIds.get(request), epoch: navigation.startEpoch(request), resourceType: request.resourceType() })
      })
      page.on('requestfinished', request => {
        if (isFavicon(request)) trace({ event: 'favicon-finished', requestId: requestIds.get(request), startEpoch: navigation.startEpoch(request), currentEpoch: navigation.epoch() })
      })
      const statuses = new WeakMap(), contentTypes = new WeakMap()
      page.on('response', response => {
        const request = response.request()
        statuses.set(request, response.status()); contentTypes.set(request, response.headers()['content-type'] ?? '')
        if (isFavicon(request)) trace({ event: 'favicon-response', requestId: requestIds.get(request), status: response.status(), svg: /^image\/svg\+xml(?:;|$)/i.test(contentTypes.get(request)), startEpoch: navigation.startEpoch(request), currentEpoch: navigation.epoch() })
      })
      page.on('pageerror', () => result.diagnostics.push({ mobile, step, type: 'pageerror', expected: false }))
      const authDiagnostics = observeAcceptanceAuthDiagnostics(page, {
        base, getIdentity: () => identity,
        report: (diagnostic, request) => result.diagnostics.push({ mobile, pageId, requestId: request && requestIds.get(request), step, ...diagnostic }),
      })
      page.on('requestfailed', request => {
        const status = statuses.get(request)
        const aborted = request.failure()?.errorText === 'net::ERR_ABORTED'
        const path = new URL(request.url()).pathname
        const nav = navigation.snapshot(request)
        trace({ event: 'requestfailed', requestId: requestIds.get(request), startEpoch: navigation.startEpoch(request), currentEpoch: navigation.epoch(), status, aborted, resourceType: request.resourceType(), requestKind: path === '/favicon.svg' ? 'favicon' : path.endsWith('/stream') ? 'stream' : path.endsWith('/events') ? 'events' : 'other', navigation: nav })
        const input = { method: request.method(), path, status, contentType: contentTypes.get(request), aborted, startEpoch: navigation.startEpoch(request), identity: authDiagnostics.identityFor(request) }
        const sameOrigin = new URL(request.url()).origin === base
        const diagnostic = { mobile, pageId, requestId: requestIds.get(request), step, type: 'requestfailed', expected: false, status, aborted, method: request.method(), path: path.replace(/[a-f0-9-]{20,}/gi, ':id'), startedMs: times.get(request), failedMs: Date.now() - startedAt, startEpoch: navigation.startEpoch(request), currentEpoch: navigation.epoch(), requestKind: path.endsWith('/events') ? 'events' : path.endsWith('/watch') ? 'watch' : path.startsWith('/assets/') ? 'asset' : path === '/api/projects' ? 'projects' : path === '/api/auth/me' ? 'auth-me' : 'other' }
        result.diagnostics.push(diagnostic)
        navigation.failure(request, evidence => {
          diagnostic.expected = sameOrigin && expectedAcceptanceAbort({ ...input, navigation: evidence })
        })
      })
    }
    await observe(page)
    const request = async (path, method = 'GET', body) => {
      let headers = {}
      if (method !== 'GET') { const me = await context.request.get(base + '/api/auth/me'); assert.equal(me.status(), 200); headers['x-csrf-token'] = (await me.json()).csrfToken }
      const response = await context.request.fetch(base + path, { method, headers, ...(body === undefined ? {} : { data: body }) })
      return readLegacyPublicResponse(response)
    }
    step = 'old-login'
    await navigate(page, 'goto', base + '/')
    await page.getByLabel('账号或邮箱', { exact: true }).fill(credentials.login)
    step = 'fill-password'
    await page.getByLabel('密码', { exact: true }).fill(credentials.password)
    step = 'old-login'
    const loginResponse = page.waitForResponse(r => r.url() === base + '/api/auth/login' && r.request().method() === 'POST')
    identity = Object.freeze({ confirmed: false, reason: 'login-in-progress' })
    await page.locator('form').filter({ has: page.locator('#auth-login') }).locator('button[type=submit]').click()
    assert.equal((await loginResponse).status(), 200)
    identity = Object.freeze({ confirmed: false, reason: 'authenticated' })
    const ownLoginId = await registerCurrentLoginCleanup({
      get: path => request(path),
      revokeCurrent: async id => {
        const me = await context.request.get(base + '/api/auth/me')
        if (me.status() === 401) return
        assert.equal(me.status(), 200)
        const response = await context.request.delete(base + `/api/auth/sessions/${id}`, { headers: { 'x-csrf-token': (await me.json()).csrfToken } })
        assert.ok(response.ok())
      },
    }, cleanupLogins)
    await page.locator('#auth-login').waitFor({ state: 'detached' })
    await page.waitForLoadState('networkidle')
    const projects = (await request('/api/projects')).items
    assert.ok(projects.length)
    await navigate(page, 'goto', base + '/projects')
    await page.getByText(projects[0].name, { exact: true }).first().waitFor()
    step = 'old-history'
    const sessions = (await request('/api/sessions')).items
    let history
    for (const session of sessions) {
      if (session.deletedAt || session.archivedAt) continue
      const events = await request(`/api/sessions/${session.id}/events?fromSeq=1&limit=500`)
      const message = events.events.find(event => event.payload?.kind === 'assistant.text.delta' && event.payload.text?.trim())
      if (message && events.freshness?.status === 'synced') { history = { session, text: message.payload.text.trim(), events }; break }
    }
    assert.ok(history, 'stable existing history required')
    const target = `/projects/${history.session.projectId}/sessions/${history.session.id}`
    const stable = async () => {
      step = 'old-history-surface'
      await page.locator(`[data-session-surface="${history.session.id}"]`).waitFor()
      step = 'old-history-text'
      await page.getByText(history.text, { exact: false }).first().waitFor()
      const events = await request(`/api/sessions/${history.session.id}/events?fromSeq=1&limit=500`)
      assert.equal(events.freshness.status, 'synced')
    }
    await navigate(page, 'goto', base + target); await stable()
    await navigate(page, 'reload'); await stable()
    await navigate(page, 'goto', base + '/projects'); await page.getByText(projects[0].name, { exact: true }).first().waitFor()
    await navigate(page, 'goBack'); await stable()
    result.checks.push({ mobile, oldIndependentLogin: true, oldHistory: true, freshness: 'synced', refreshBack: true, session: fingerprint(history.session.id) })
    if (!mobile && process.env.WEMUX_LEGACY_TEST_WRITE === '1') {
      step = 'test-task-prepare'
      const workers = (await request('/api/workers')).items
      const { selection, safeTargets } = await findSafeTestAgentTarget({ projects, workers, request })
      result.safeTargets = safeTargets
      assert.ok(selection, 'safe Test Agent target required')
      const { project, workspace, worker, model } = selection
      const prefix = `/api/projects/${encodeURIComponent(project.id)}/tasks`
      step = 'test-task-create-bind'
      let { task } = await createRetainedTestTask({ selection, request, retain: async (record, task) => {
        retained = record
        result.retained = { project: fingerprint(record.projectId), task: fingerprint(record.taskId), workspace: fingerprint(record.workspaceId), status: task.status, bindingOutcome: record.bindingOutcome, recovery: 'See retained-private.json; manual authorization required; no automatic retry or cleanup.' }
        await mkdir(evidence, { recursive: true, mode: 0o700 })
        await writeFile(evidence + '/retained-private.json', JSON.stringify(record), { mode: 0o600 })
      } })
      task = await request(`${prefix}/${task.id}/assignment`, 'PUT', { version: task.version, assignee: { workspaceId: workspace.id, workerId: worker.id, agentKey: 'test', modelId: model.modelId } })
      step = 'test-ui-create'
      await navigate(page, 'goto', `${base}/projects/${project.id}/tasks/${task.id}?tab=runs`)
      const creation = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `${prefix}/${task.id}/sessions`)
      await page.getByRole('button', { name: '创建独立任务会话（不启动 Run）', exact: true }).click()
      const created = await creation; assert.equal(created.status(), 201)
      const sessionId = (await created.json()).session.id
      retained.sessionId = sessionId; result.retained.session = fingerprint(sessionId)
      await writeFile(evidence + '/retained-private.json', JSON.stringify(retained), { mode: 0o600 })
      await page.getByRole('link', { name: '打开独立会话', exact: true }).click()
      await page.locator(`[data-session-surface="${sessionId}"]`).waitFor()
      step = 'test-ui-send'
      const marker = 'Ticket01 safe Test Agent transport acceptance'
      await page.getByLabel('消息内容', { exact: true }).fill(marker)
      const accepted = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/sessions/${sessionId}/messages`)
      await page.getByTitle('发送消息', { exact: true }).click()
      const receipt = await accepted; assert.ok(receipt.ok())
      const receiptBody = await receipt.json()
      if (receiptBody.commandId) result.retained.command = fingerprint(receiptBody.commandId)
      await page.getByText('Echo: ' + marker, { exact: false }).first().waitFor()
      const settled = async () => {
        for (let i = 0; i < 60; i++) {
          const events = await request(`/api/sessions/${sessionId}/events?fromSeq=1&limit=500`)
          if (events.freshness?.status === 'synced' && events.events.some(e => e.payload?.kind === 'turn.finished' && e.payload.outcome === 'completed')) return events
          await page.waitForTimeout(250)
        }
        throw Error('settlement missing')
      }
      const events = await settled()
      result.retained.lastSeq = events.events.at(-1).seq
      await navigate(page, 'reload'); await page.getByText('Echo: ' + marker, { exact: false }).first().waitFor(); await settled()
      assert.equal((await request(`${prefix}/${task.id}/runs`)).items.length, 0)
      result.checks.push({ testAgentOnly: true, uiCreatedSession: true, uiSentMessage: true, durableTerminalReadback: true, noRun: true })
    }
    if (!mobile && process.env.WEMUX_LEGACY_RETAINED_FILE) {
      step = 'retained-readback'
      const saved = JSON.parse(await readFile(process.env.WEMUX_LEGACY_RETAINED_FILE, 'utf8'))
      for (const key of ['projectId', 'taskId', 'workspaceId', 'workerId', 'sessionId']) assert.ok(typeof saved[key] === 'string' && saved[key])
      const prefix = `/api/projects/${encodeURIComponent(saved.projectId)}/tasks/${encodeURIComponent(saved.taskId)}`
      const task = await request(prefix)
      const bindings = (await request(`${prefix}/workspaces`)).items
      const session = await request(`/api/sessions/${encodeURIComponent(saved.sessionId)}`)
      step = 'retained-task-binding'
      assert.equal(task.id, saved.taskId)
      assert.equal(task.projectId, saved.projectId)
      assert.ok(bindings.some(item => item.workspaceId === saved.workspaceId && item.taskId === saved.taskId && item.projectId === saved.projectId))
      step = 'retained-session-binding'
      assert.equal(session.id, saved.sessionId)
      for (const key of ['projectId', 'workspaceId']) assert.equal(session[key], saved[key])
      assert.equal(session.binding.agent.workerId, saved.workerId)
      assert.equal(session.binding.agent.agentKey, 'test')
      step = 'retained-task-activity'
      const activity = (await request(`${prefix}/activity`)).items
      assert.ok(activity.some(item => item.payload?.action === 'session.created' && item.payload.sessionId === saved.sessionId))
      step = 'retained-placement'
      const workspaces = (await request('/api/workspaces')).items
      assert.ok(workspaces.some(item => item.id === saved.workspaceId && item.projectId === saved.projectId && item.placements.some(placement => placement.workerId === saved.workerId)))
      assert.ok((await request('/api/workers')).items.some(item => item.id === saved.workerId))
      assert.equal((await request(`${prefix}/runs`)).items.length, 0)
      step = 'retained-terminal'
      const events = await request(`/api/sessions/${encodeURIComponent(saved.sessionId)}/events?fromSeq=1&limit=500`)
      assert.equal(events.freshness.status, 'synced')
      assert.ok(events.events.some(event => event.payload?.kind === 'turn.finished' && event.payload.outcome === 'completed'))
      step = 'retained-spa'
      await navigate(page, 'goto', `${base}/projects/${saved.projectId}/tasks/${saved.taskId}?tab=runs`)
      // The post-create link is transient React state, not a retained-history
      // entry. Reopen the existing Session through its ordinary sidebar control.
      await page.getByRole('region', { name: '最近会话' }).getByRole('button').filter({ has: page.getByText(session.title, { exact: true }) }).click()
      await page.locator(`[data-session-surface="${saved.sessionId}"]`).waitFor()
      await page.getByText('Echo: Ticket01 safe Test Agent transport acceptance', { exact: false }).first().waitFor()
      result.checks.push({ retainedIdsVerified: true, retainedTestAgent: true, retainedNoRun: true, retainedDurableTerminal: true, retainedSpaReadOnly: true })
    }
    step = 'before-revoke'
    const next = await context.newPage(); await observe(next)
    const nextTarget = `/next/projects/${projects[0].id}`
    await navigate(next, 'goto', base + nextTarget); await next.getByRole('heading', { name: projects[0].name, exact: true }).waitFor()
    const logins = (await request('/api/auth/sessions')).items
    const current = logins.find(item => item.current)
    assert.equal(current?.id, ownLoginId, 'only the originally recorded current test login may be revoked')
    step = 'revoking'
    identity = Object.freeze({ confirmed: false, reason: 'revoking-current-login' })
    await request(`/api/auth/sessions/${ownLoginId}`, 'DELETE')
    identity = Object.freeze({ confirmed: true, reason: 'revoked-current-login' })
    step = 'revoked'
    await navigate(next, 'reload'); await next.getByRole('heading', { name: '登录控制台' }).waitFor()
    assert.equal(new URL(next.url()).pathname, nextTarget)
    assert.equal(await next.getByRole('heading', { name: projects[0].name, exact: true }).count(), 0)
    const oldTarget = new URL(page.url()).pathname
    await navigate(page, 'reload'); await page.getByLabel('账号或邮箱', { exact: true }).waitFor()
    assert.equal(new URL(page.url()).pathname, oldTarget)
    assert.equal(await page.locator('[data-session-surface]').count(), 0)
    result.checks.push({ mobile, currentLoginRevokedViaPublicAPI: true, oldAndNextCleared: true, returnTargetsPreserved: true })
    cleanupLogins.pop()
    await context.close()
  }
  result.permissionFiltering = 'blocked: no supplied restricted-account credential; no account creation or privilege change'
  assert.deepEqual(result.diagnostics.filter(d => !d.expected), [])
  result.passed = true
} catch { recordAcceptanceFailure(result, step) }
finally {
  process.exitCode = await finishAcceptance(result, [...cleanupLogins, () => browser?.close()], async value => {
    await mkdir(evidence, { recursive: true, mode: 0o700 })
    await writeFile(evidence + '/result.json', JSON.stringify(value, null, 2), { mode: 0o600 })
  })
  if (result.passed) console.log('PASS legacy real-instance regression')
  else console.error('Acceptance failed (details withheld).')
}
