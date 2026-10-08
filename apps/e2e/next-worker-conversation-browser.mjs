/** Owned Server + actual Worker CLI + Next desktop/mobile. Deterministic Test Agent,
 * not native/paid Runtime evidence. No synthetic Worker or Journal insertion.
 * WEMUX_NEXT_TEST_DIST=/tmp/... node --import tsx apps/e2e/next-worker-conversation-browser.mjs
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
import { invokeCapability, parseInvocation } from '../worker/src/agent-cli.ts'

assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'), 'owned temporary build required')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')
const evidence = await mkdtemp(join(tmpdir(), 'wemux-next-worker-browser-'))
const home = join(evidence, 'worker'), email = 'next-worker@example.test', password = 'owned-browser-test-password'
const app = createWemuxServer({ databasePath: join(evidence, 'server.sqlite'), administratorEmails: [email], mail: {}, google: {}, webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST) })
const origin = await app.listen(0)
const checks = [], errors = [], sessions = []
let browser, worker, activePage, step = 'setup'
const transportTrace = []
function launch(args) {
  const isolated = ownedWorkerLaunch(args, origin)
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...isolated.args], { cwd: process.cwd(), env: isolated.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })) })
  // Observe spawn failures immediately, even while the caller is awaiting HTTP.
  void done.catch(() => {})
  return { child, done }
}
async function stopWorker() {
  if (!worker) return
  const current = worker; worker = undefined
  if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill('SIGTERM')
  const timer = setTimeout(() => current.child.kill('SIGKILL'), 10000)
  try { const result = await current.done; assert.equal(result.code, 0, 'Worker must close gracefully') }
  finally { clearTimeout(timer) }
}
async function eventually(read, accept, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await delay(50) }
  throw Error(`Timed out: ${label}`)
}
const check = name => checks.push(`${step}: ${name}`)
try {
  const owner = await provisionAdministrator({ store: app.store, baseUrl: origin, email, password })
  const api = owner.api
  await api('/bootstrap', 'POST', {})
  const enrollment = await api('/enrollment-tokens', 'POST', {})
  const registration = launch(['register', '--home', home, `--token=${enrollment.token}`, '--name', 'Owned Next Worker'])
  const registered = await registration.done
  assert.equal(registered.code, 0, 'isolated Worker registration')
  const workerId = JSON.parse(registered.stdout).workerId
  const start = () => { worker = launch(['start', '--home', home, '--name', 'Owned Next Worker']) }
  start()
  await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities.some(c => c.agentKey === 'test' && c.availability.status === 'available'), 'actual Worker capabilities')
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    step = `${name}: create`
    const project = await api('/projects', 'POST', { name: `真实 Worker ${name}`, teamId: 'default-team', requestId: `project-${name}` })
    const task = await api(`/projects/${project.id}/tasks`, 'POST', { title: `持续对话 ${name}`, requestId: `task-${name}` })
    const provision = await api('/workspaces', 'POST', { projectId: project.id, workerId, name: `空工作区 ${name}`, source: 'empty', requestId: `workspace-${name}` })
    const workspaceId = provision.workspace.id
    await eventually(() => api(`/workspaces/${workspaceId}`), w => w.placements.some(p => p.workerId === workerId && p.status === 'ready'), 'Worker provisioned placement')
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: email, password } })).status(), 200)
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(15000)
    page.on('pageerror', error => errors.push({ name, step, message: error.message }))
    // Observe one real gesture, never retry or synthesize an application click.
    // SSE can invalidate actionability after Playwright checks it. Record the exact
    // target so an unrelated/bubbled document click is not mistaken for admission.
    const clickAction = async button => {
      await button.evaluate(target => {
        window.actionProbe?.dispose()
        const probe = { events: [] }
        const mark = event => probe.events.push({ type: event.type, onTarget: event.composedPath().includes(target), disabled: target.disabled, targetTag: event.target.tagName, targetLabel: event.target.getAttribute('aria-label') ?? event.target.textContent?.slice(0, 80) })
        const types = ['pointerdown', 'pointerup', 'click', 'submit']
        for (const type of types) document.addEventListener(type, mark, true)
        probe.dispose = () => { for (const type of types) document.removeEventListener(type, mark, true) }
        window.actionProbe = probe
      })
      try { await button.click() }
      finally {
        const events = await page.evaluate(() => { window.actionProbe.dispose(); return window.actionProbe.events })
        transportTrace.push({ name, step, phase: 'gesture', events })
      }
    }
    const surface = page.getByRole('region', { name: '任务会话', exact: true })
    const panel = page.getByRole('region', { name: '任务会话对话', exact: true })
    const controls = panel.getByRole('region', { name: '队列与 Turn 控制', exact: true })
    const history = panel.getByRole('region', { name: '会话历史', exact: true })
    const composer = panel.getByRole('region', { name: '消息提交', exact: true })
    await page.goto(`${origin}/next/projects/${project.id}?task=${task.id}`)
    const environment = surface.getByLabel('会话执行环境', { exact: true })
    const selection = JSON.stringify([workspaceId, workerId, 'test', 'test'])
    await eventually(() => environment.locator('option').evaluateAll(options => options.map(o => o.value)), values => values.includes(selection), 'actual Worker environment option')
    await environment.selectOption(selection)
    const title = `真实会话 ${name}`
    await surface.getByLabel('会话标题', { exact: true }).fill(title)
    const createdResponse = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/projects/${project.id}/tasks/${task.id}/sessions`)
    await surface.getByRole('button', { name: '创建任务会话', exact: true }).click()
    const createdHttp = await createdResponse; assert.equal(createdHttp.status(), 201)
    const created = await createdHttp.json(), id = created.session.id
    sessions.push({ name, projectId: project.id, taskId: task.id, sessionId: id })
    assert.equal(created.session.taskId, task.id)
    await eventually(() => api(`/commands/${created.commandId}`), c => c.status === 'accepted', 'Worker accepted Session')
    // Admission is not runtime readiness. The response-loss scenario starts only
    // after the Worker created the Session and its first journal head caught up.
    // Refresh-during-gesture refusal is exercised separately in next-composer-browser.
    await eventually(() => api(`/sessions/${id}`), s => s.freshness.status === 'synced' && s.freshness.contiguousSeq >= 1, 'initial Session journal synchronized')
    await surface.getByRole('button', { name: `查看会话：${title}`, exact: true }).click()
    const journal = () => api(`/sessions/${id}/events?fromSeq=1&limit=1000`)
    const metadata = () => api(`/sessions/${id}`)
    const refresh = async () => { await panel.getByRole('button', { name: '刷新会话历史', exact: true }).click(); await panel.getByText('已读取会话', { exact: true }).waitFor() }
    const send = async text => {
      await composer.getByLabel('新消息草稿', { exact: true }).fill(text)
      const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/sessions/${id}/messages`)
      await clickAction(composer.getByRole('button', { name: '发送新消息', exact: true }))
      const received = await response; assert.equal(received.status(), 202)
      return received.json()
    }
    check('Task creation reached actual Worker; immutable Task Session binding')

    step = `${name}: lost response`
    const messagePath = `/api/sessions/${id}/messages`, posts = []
    const messageRoute = url => url.pathname === messagePath
    let lose = true
    await page.route(messageRoute, async route => {
      if (route.request().method() !== 'POST') return route.continue()
      const body = route.request().postDataJSON()
      transportTrace.push({ name, phase: 'intercepted', commandId: body.commandId })
      const response = await route.fetch(), receipt = await response.json()
      posts.push({ body, receipt })
      transportTrace.push({ name, phase: 'committed', status: response.status(), commandId: body.commandId })
      if (lose) { lose = false; await route.abort('failed'); transportTrace.push({ name, phase: 'aborted', commandId: body.commandId }) } else await route.fulfill({ response })
    })
    await composer.getByLabel('新消息草稿', { exact: true }).fill(`hello-${name}`)
    await clickAction(composer.getByRole('button', { name: '发送新消息', exact: true }))
    transportTrace.push({ name, phase: 'clicked', composer: await composer.innerText() })
    await composer.getByRole('button', { name: '重试原消息', exact: true }).waitFor()
    await page.reload()
    await eventually(metadata, value => value.freshness.status === 'synced', 'Worker head caught up before explicit retry')
    await composer.getByRole('button', { name: '重试原消息', exact: true }).waitFor({ state: 'visible' })
    await eventually(() => composer.getByRole('button', { name: '重试原消息', exact: true }).isEnabled(), enabled => enabled, 'retry enabled after metadata convergence')
    await clickAction(composer.getByRole('button', { name: '重试原消息', exact: true }))
    await eventually(() => Promise.resolve(posts.length), length => length === 2, 'original message replay')
    assert.deepEqual(posts[0].body, posts[1].body)
    assert.equal(posts[0].receipt.commandId, posts[1].receipt.commandId)
    const firstPage = await eventually(journal, p => p.events.some(e => e.payload.kind === 'turn.finished' && e.payload.outcome === 'completed'), 'completed echo')
    // Read through the actual Worker CLI adapter with the authenticated Turn's
    // short-lived grant; never include its token in the browser evidence files.
    const admitted = await app.store.commands.getPendingCommand(posts[0].receipt.commandId)
    assert.equal(admitted?.command.kind, 'session.enqueue')
    const grant = admitted.command.capabilities?.token
    assert.ok(grant, 'owner-authored message must issue a scoped Turn grant')
    const cliEnvironment = { WEMUX_CAPABILITY_ENDPOINT: `${origin}/api/agent-capabilities`, WEMUX_CAPABILITY_TOKEN: grant }
    const query = (args) => invokeCapability(parseInvocation(args), cliEnvironment)
    const syncedPage = await eventually(journal, page => page.freshness.status === 'synced' && page.events.some(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed'), 'first Turn Journal settled before paired query')
    const cliMetadata = await eventually(() => query(['session', 'get', '--session-id', id]), value => value.session.freshness.status === 'synced', 'CLI head converged before paired query')
    assert.equal(cliMetadata.session.id, id)
    assert.equal(cliMetadata.session.taskId, task.id)
    const cliHistory = await query(['session', 'events', '--session-id', id, '--from-seq', '1', '--limit', '1000'])
    assert.equal(cliHistory.freshness.status, syncedPage.freshness.status)
    assert.deepEqual(cliHistory.events.map(event => event.seq), syncedPage.events.map(event => event.seq))
    const cliTaskSessions = await query(['task', 'sessions', '--project-id', project.id, '--task-id', task.id, '--limit', '1'])
    assert.deepEqual(cliTaskSessions.items.map(item => item.id), [id])
    check('Web and actual Agent CLI adapter share scoped Task Session identity, journal cursor and freshness')
    assert.equal(firstPage.events.filter(e => e.payload.kind === 'message.queued').length, 1)
    assert.equal(firstPage.events.filter(e => e.payload.kind === 'turn.started').length, 1)
    await refresh()
    await history.getByText(`Echo: hello-${name}`, { exact: true }).waitFor()
    await history.getByText('工具：echo（已完成）', { exact: true }).waitFor()
    check('lost successful send response + reload retries same identity; one actual Turn and tool history')
    await page.unroute(messageRoute)

    step = `${name}: queue and stop`
    const slow = await send('[test-agent:pause-ms=60000] hold-current')
    const active = await eventually(metadata, s => !!s.activeTurnId, 'slow active Turn')
    await send(`keep-queued-${name}`)
    const cancel = await send(`cancel-queued-${name}`)
    await eventually(metadata, s => s.queuedMessages.some(m => m.commandId === cancel.commandId), 'second queued message')
    await refresh()
    await clickAction(controls.getByRole('button', { name: `取消排队消息 ${cancel.commandId}`, exact: true }))
    await eventually(journal, p => p.events.some(e => e.payload.kind === 'message.cancelled' && e.payload.messageId === cancel.messageId), 'actual queue cancellation')
    await refresh()
    await clickAction(controls.getByRole('button', { name: `停止当前 Turn ${active.activeTurnId}`, exact: true }))
    const afterStop = await eventually(journal, p => p.events.some(e => e.payload.kind === 'turn.finished' && e.payload.turnId === active.activeTurnId && e.payload.outcome === 'cancelled') && p.events.some(e => e.payload.kind === 'assistant.text.delta' && e.payload.text.includes('keep-que')), 'stop preserves later queued execution')
    await eventually(metadata, s => !s.activeTurnId && s.queuedMessages.length === 0, 'remaining Turn complete')
    const final = await journal()
    assert.equal(final.events.filter(e => e.payload.kind === 'turn.started').length, 3)
    assert.equal(final.events.filter(e => e.payload.kind === 'message.queued' && e.payload.messageId === slow.messageId).length, 1)
    assert.equal(afterStop.events.filter(e => e.payload.kind === 'message.cancelled' && e.payload.messageId === cancel.messageId).length, 1)
    await refresh(); await history.getByText(`Echo: keep-queued-${name}`, { exact: true }).waitFor()
    await history.getByText(`消息已取消：${cancel.messageId}`, { exact: true }).waitFor()
    check('browser cancels exact queued message and stops exact Turn; later message executes once')

    step = `${name}: unsupported model`
    await panel.getByText('当前 Worker 未提供可切换模型，或此 Agent 的模型已固定。', { exact: true }).waitFor()
    assert.equal(await controls.getByRole('combobox', { name: '选择后续模型', exact: true }).isDisabled(), true)
    check('fixed-model Test Agent is honestly disabled, no simulated model switch')

    step = `${name}: restart`
    await composer.getByLabel('新消息草稿', { exact: true }).fill(`saved-draft-${name}`)
    await stopWorker()
    await eventually(() => api('/workers'), p => p.items.some(w => w.id === workerId && w.connectionState === 'offline'), 'Worker offline')
    await refresh(); await panel.getByText(/元数据新鲜度：Worker 离线/).waitFor()
    const offline = await query(['session', 'events', '--session-id', id, '--from-seq', '1', '--limit', '1000'])
    assert.equal(offline.freshness.status, 'offline')
    assert.equal((await query(['session', 'get', '--session-id', id])).session.freshness.status, 'offline')
    assert.equal((await journal()).freshness.status, 'offline')
    check('same authorized CLI grant and browser observe Worker offline without exposing stale history as synced')
    start()
    await eventually(() => api('/workers'), p => p.items.some(w => w.id === workerId && w.connectionState === 'online'), 'Worker reconnected')
    await page.reload()
    assert.equal(await panel.getAttribute('data-conversation-session'), id)
    await history.getByText(`Echo: hello-${name}`, { exact: true }).waitFor()
    await eventually(() => composer.getByLabel('新消息草稿', { exact: true }).inputValue(), value => value === `saved-draft-${name}`, 'draft after reload')
    await send(`after-restart-${name}`)
    const recoveredJournal = await eventually(journal, p => p.events.filter(e => e.payload.kind === 'turn.finished' && e.payload.outcome === 'completed').length === 3 && p.freshness.status === 'synced', 'same Session after restart')
    await refresh(); await history.getByText(`Echo: after-restart-${name}`, { exact: true }).waitFor()
    await panel.getByText(/元数据新鲜度：已同步/).waitFor()
    const recovered = await query(['session', 'events', '--session-id', id, '--from-seq', '1', '--limit', '1000'])
    assert.equal(recovered.freshness.status, 'synced')
    assert.deepEqual(recovered.events.map(event => event.seq), recoveredJournal.events.map(event => event.seq))
    assert.equal((await query(['session', 'get', '--session-id', id])).session.freshness.status, 'synced')
    check('same authorized CLI grant and browser observe recovered Worker journal and continuation')
    assert.equal((await api(`/projects/${project.id}/tasks/${task.id}/sessions`)).items.length, 1)
    assert.equal((await api(`/projects/${project.id}/tasks/${task.id}/runs`)).items.length, 0)
    await page.screenshot({ path: join(evidence, `${name}-recovered.png`), fullPage: true })
    check('Worker restart + browser reload preserves Session, draft, history; new message executes after reconnect')
    step = `${name}: root entry conversion`
    const quickRequest = { requestId: `quick-${name}`, workspaceId, workerId, agentKey: 'test', modelId: 'test', title: `自动任务会话 ${name}` }
    const quick = await api('/sessions', 'POST', quickRequest)
    assert.ok(quick.session.taskId)
    assert.notEqual(quick.session.taskId, task.id)
    assert.equal(quick.session.shareScope, 'owner-only')
    const replayQuick = await api('/sessions', 'POST', quickRequest)
    assert.equal(replayQuick.session.id, quick.session.id)
    assert.equal(replayQuick.commandId, quick.commandId)
    const another = await api('/sessions', 'POST', { ...quickRequest, requestId: `quick-second-${name}` })
    assert.equal(another.session.taskId, quick.session.taskId)
    assert.notEqual(another.session.id, quick.session.id)
    const quickTaskPath = `/projects/${project.id}/tasks/${quick.session.taskId}`
    assert.equal((await api(`${quickTaskPath}/sessions`)).items.length, 2)
    assert.equal((await api(`${quickTaskPath}/runs`)).items.length, 0)
    await eventually(() => api(`/commands/${quick.commandId}`), c => c.status === 'accepted', 'Worker accepted converted root Session')
    await eventually(() => api(`/sessions/${quick.session.id}`), s => s.freshness.status === 'synced' && s.freshness.contiguousSeq >= 1, 'converted Session journal synchronized')
    await page.goto(`${origin}/next/projects/${project.id}?task=${encodeURIComponent(quick.session.taskId)}`)
    // Both Sessions intentionally have the same title; choose by the resulting panel identity.
    const quickButtons = surface.getByRole('button', { name: `查看会话：${quickRequest.title}`, exact: true })
    await eventually(() => quickButtons.count(), count => count === 2, 'dedicated Task discovers both quick Sessions')
    await quickButtons.first().click()
    if (await panel.getAttribute('data-conversation-session') !== quick.session.id) await quickButtons.last().click()
    assert.equal(await panel.getAttribute('data-conversation-session'), quick.session.id)
    await composer.getByLabel('新消息草稿', { exact: true }).fill(`converted-root-${name}`)
    const quickSend = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/sessions/${quick.session.id}/messages`)
    await clickAction(composer.getByRole('button', { name: '发送新消息', exact: true }))
    assert.equal((await quickSend).status(), 202)
    await eventually(() => api(`/sessions/${quick.session.id}/events?fromSeq=1&limit=1000`), p => p.events.some(e => e.payload.kind === 'turn.finished' && e.payload.outcome === 'completed'), 'converted root actual Turn')
    await page.reload()
    assert.equal(await panel.getAttribute('data-conversation-session'), quick.session.id)
    await history.getByText(`Echo: converted-root-${name}`, { exact: true }).waitFor()
    await page.screenshot({ path: join(evidence, `${name}-dedicated-task.png`), fullPage: true })
    sessions.push({ name, entry: 'root API conversion + Next browser', projectId: project.id, taskId: quick.session.taskId, sessionId: quick.session.id })
    check('legacy root API atomically provides/reuses dedicated Task; Next browser sends and reloads actual Worker history')
    step = `${name}: Next dedicated entry lost response`
    await page.goto(`${origin}/next/projects/${project.id}`)
    await page.getByRole('navigation', { name: '项目管理' }).getByRole('button', { name: '试聊', exact: true }).click()
    const trial = page.getByRole('region', { name: '项目试聊', exact: true })
    await trial.getByLabel('试聊标题', { exact: true }).fill(`Next试聊 ${name}`)
    const trialTarget = trial.getByLabel('试聊执行环境', { exact: true })
    await eventually(() => trialTarget.locator('option').allTextContents(), values => values.length > 1, 'trial environment ready')
    const option = await trialTarget.locator('option').evaluateAll(elements => elements.find(el => el.value && el.textContent.includes('test'))?.value)
    assert.ok(option); await trialTarget.selectOption(option)
    const trialBodies = []; let lostTrial
    const loseTrial = async route => {
      if (route.request().method() !== 'POST') return route.continue()
      trialBodies.push(route.request().postDataJSON())
      const response = await route.fetch(); assert.equal(response.status(), 201)
      lostTrial = await response.json(); await route.abort('failed')
    }
    await page.route('**/api/sessions?*', loseTrial)
    await trial.getByRole('button', { name: '创建试聊会话', exact: true }).click()
    await trial.getByRole('button', { name: '重试原试聊请求', exact: true }).waitFor()
    assert.ok(lostTrial?.session.taskId)
    assert.equal(lostTrial.session.taskId, quick.session.taskId)
    await page.unroute('**/api/sessions?*', loseTrial)
    await page.reload()
    await page.getByRole('navigation', { name: '项目管理' }).getByRole('button', { name: '试聊', exact: true }).click()
    await trial.getByRole('button', { name: '重试原试聊请求', exact: true }).waitFor()
    await page.route('**/api/sessions?*', async route => { if (route.request().method() === 'POST') trialBodies.push(route.request().postDataJSON()); await route.continue() })
    // The mounted UI still holds the old request while same-tab storage loses it.
    // A stale retry must settle visibly without minting from the current form.
    const pendingTrial = await page.evaluate(requestId => {
      const entries = Object.entries(sessionStorage).filter(([key, raw]) => key.startsWith('wemux.dedicated-session:') && JSON.parse(raw).requestId === requestId)
      if (entries.length !== 1) throw Error('Expected one exact dedicated pending identity')
      const [key, raw] = entries[0]; sessionStorage.removeItem(key); return { key, raw }
    }, trialBodies[0].requestId)
    await trial.getByLabel('试聊标题', { exact: true }).fill(`不得新建 ${name}`)
    await trialTarget.selectOption(option)
    await trial.getByRole('button', { name: '重试原试聊请求', exact: true }).click()
    await trial.getByRole('alert').filter({ hasText: '原请求状态已变化，未创建新的会话。' }).waitFor()
    await eventually(() => trial.getByRole('button', { name: '重试原试聊请求', exact: true }).count(), count => count === 0, 'stale retry settled and cleared from view')
    assert.equal(trialBodies.length, 1, 'stale retry must not POST a new request')
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), pendingTrial.key), null, 'stale retry must not mint a stored identity')
    assert.equal((await api(`${quickTaskPath}/sessions`)).items.length, 3, 'stale retry must not create a second Session')
    check('stale dedicated retry after same-tab storage loss rejects without POST or new identity despite valid edited form')
    // Restore precisely the test-owned lost body and prove normal replay still works.
    await page.evaluate(({ key, raw }) => sessionStorage.setItem(key, raw), pendingTrial)
    await page.reload()
    await page.getByRole('navigation', { name: '项目管理' }).getByRole('button', { name: '试聊', exact: true }).click()
    await trial.getByRole('button', { name: '重试原试聊请求', exact: true }).click()
    await eventually(() => panel.getAttribute('data-conversation-session'), value => value === lostTrial.session.id, 'trial retry opens same Session')
    assert.equal(trialBodies.length, 2); assert.deepEqual(trialBodies[0], trialBodies[1])
    assert.equal((await api(`${quickTaskPath}/sessions`)).items.length, 3)
    assert.equal((await api(`${quickTaskPath}/runs`)).items.length, 0)
    await eventually(() => api(`/sessions/${lostTrial.session.id}`), s => s.freshness.status === 'synced' && s.freshness.contiguousSeq >= 1, 'trial journal ready')
    await page.reload()
    await composer.getByLabel('新消息草稿', { exact: true }).fill(`next-trial-${name}`)
    const trialSend = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/sessions/${lostTrial.session.id}/messages`)
    await clickAction(composer.getByRole('button', { name: '发送新消息', exact: true }))
    assert.equal((await trialSend).status(), 202)
    await eventually(() => api(`/sessions/${lostTrial.session.id}/events?fromSeq=1&limit=1000`), p => p.events.some(e => e.payload.kind === 'turn.finished'), 'trial actual Turn finished')
    await page.reload(); await history.getByText(`Echo: next-trial-${name}`, { exact: true }).waitFor()
    await page.screenshot({ path: join(evidence, `${name}-next-trial.png`), fullPage: true })
    check('Next trial automatically reuses dedicated Task, recovers lost creation response across reload with same body, sends and restores actual history')
    await context.close()
  }
  assert.deepEqual(errors, [])
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ ok: true, checks, sessions, errors, transportTrace, runtime: 'actual Worker CLI + deterministic Test Agent; NOT native Runtime approval/model evidence' }, null, 2))
  console.log(JSON.stringify({ evidence, checks: checks.length }))
} catch (error) {
  const browserState = activePage && !activePage.isClosed() ? await activePage.evaluate(() => ({ url: location.href, text: document.body.innerText, storage: Object.fromEntries(Object.entries(sessionStorage)) })).catch(() => null) : null
  await activePage?.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {})
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ step, message: String(error), checks, errors, transportTrace, browserState }, null, 2))
  throw error
} finally {
  await browser?.close()
  try { await stopWorker() } finally {
    await app.close()
    await rm(home, { recursive: true, force: true })
    await removeOwnedServerDatabases(join(evidence, 'server.sqlite'))
    await writeFile(join(evidence, 'cleanup.json'), JSON.stringify({ ownedServerClosed: true, ownedWorkerStopped: true, ownedBrowserClosed: true, databaseAndWorkerHomeRemoved: true }))
  }
}
