/** Real /next UI + owned temporary Server; synthetic Worker capabilities, no Runtime execution.
 * node_modules/.bin/vite build --config apps/web-next/vite.config.ts --outDir /tmp/wemux-next-task-session-dist
 * WEMUX_NEXT_TEST_DIST=/tmp/wemux-next-task-session-dist node --import tsx apps/e2e/next-task-session-browser.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createWemuxServer } from '../server/src/server.ts'
import { provisionAdministrator } from './session.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'

assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'), 'build only into an owned temporary directory')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')
const evidence = await mkdtemp(join(tmpdir(), 'wemux-next-task-session-browser-'))
const email = 'next-session-owner@example.test', password = 'synthetic-next-session-password'
const app = createWemuxServer({ databasePath: join(evidence, 'server.sqlite'), administratorEmails: [email], mail: {}, google: {}, webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST) })
const origin = await app.listen(0)
const checks = [], posts = [], errors = [], consoleErrors = [], remountRetries = [], discoveryBarriers = []
// Test-only negative control: inject a stale row after body consumption, during the next UI frame.
const discoveryNegativeControl = process.env.WEMUX_DISCOVERY_NEGATIVE_CONTROL === '1'
let browser, step = 'setup'
const check = (ok, name) => { assert.ok(ok, name); checks.push(name) }
try {
  const owner = await provisionAdministrator({ store: app.store, baseUrl: origin, email, password })
  await owner.api('/bootstrap', 'POST', {})
  const viewerEmail = 'next-session-viewer@example.test'
  await seedLocalAccount(app.store, { username: viewerEmail, email: viewerEmail, password })
  const viewerLogin = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: viewerEmail, password }) })
  assert.equal(viewerLogin.status, 200)
  const viewerCookie = viewerLogin.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
  const viewerPayload = await viewerLogin.json()
  const invite = await owner.api('/teams/default-team/invitations', 'POST', { email: viewerEmail })
  assert.equal((await fetch(`${origin}/api/team-invitations/${invite.token}/accept`, { method: 'POST', headers: { Cookie: viewerCookie, 'x-csrf-token': viewerPayload.csrfToken, 'content-type': 'application/json' }, body: '{}' })).status, 200)
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    step = `${name}: fixtures`
    const project = await owner.api('/projects', 'POST', { name: `会话验收 ${name}`, teamId: 'default-team', requestId: `project-${name}` })
    await owner.api(`/projects/${project.id}/access`, 'PATCH', { shareScope: 'team' })
    const task = await owner.api(`/projects/${project.id}/tasks`, 'POST', { title: `任务会话 ${name}`, requestId: `task-${name}` })
    const other = await owner.api(`/projects/${project.id}/tasks`, 'POST', { title: `隔离任务 ${name}`, requestId: `other-${name}` })
    const deleted = await owner.api(`/projects/${project.id}/tasks`, 'POST', { title: `已删除任务 ${name}`, requestId: `deleted-${name}` })
    await owner.api(`/projects/${project.id}/tasks/${deleted.id}`, 'DELETE', { version: deleted.version, requestId: `delete-${name}` })
    const selection = { workspaceId: `space-${name}`, workerId: `worker-${name}`, agentKey: 'synthetic', modelId: 'provider/model' }
    await app.store.transaction(async tx => {
      await tx.resources.saveWorker({ id: selection.workerId, teamId: project.teamId, ownerId: project.ownerId, name: `合成节点 ${name}`, shareScope: 'team', connectionState: 'online', version: '1', platform: 'linux', lastSeenAt: new Date().toISOString(), capabilities: [{ agentKey: selection.agentKey, displayName: '合成执行者', version: '1', mode: 'execution', modelSwap: true, availability: { status: 'available' }, models: [{ modelId: selection.modelId, displayName: '指定模型', source: 'configured' }, { modelId: 'second', displayName: '另一个模型', source: 'configured' }] }, { agentKey: 'unavailable', displayName: '不可用执行者', mode: 'execution', availability: { status: 'unavailable' }, models: [{ modelId: 'invalid', displayName: '不可用模型', source: 'configured' }] }] })
      await tx.resources.saveWorkspace({ id: selection.workspaceId, projectId: project.id, name: `会话工作区 ${name}`, spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [{ workerId: selection.workerId, status: 'ready', failureReason: null, location: null }], deletedAt: null })
      await tx.resources.saveWorkspace({ id: `failed-${name}`, projectId: project.id, name: '未就绪工作区', spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [{ workerId: selection.workerId, status: 'failed', failureReason: 'test failure', location: null }], deletedAt: null })
    })
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    const login = await context.request.post(`${origin}/api/auth/login`, { data: { login: email, password } }); assert.equal(login.status(), 200)
    const page = await context.newPage(); page.setDefaultTimeout(12000)
    page.on('pageerror', error => errors.push(`${name}: ${error.message}`))
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ name, step, text: message.text() }) })
    const path = id => `${origin}/next/projects/${project.id}?task=${id}`
    const surface = page.getByRole('region', { name: '任务会话', exact: true })
    const create = surface.getByRole('button', { name: '创建任务会话', exact: true })
    const environment = surface.getByLabel('会话执行环境', { exact: true })
    const title = surface.getByLabel('会话标题', { exact: true })
    const choose = async (model = selection.modelId) => environment.selectOption(JSON.stringify([selection.workspaceId, selection.workerId, selection.agentKey, model]))
    const sessionPath = `/api/projects/${project.id}/tasks/${task.id}/sessions`
    let lose = true, hold = false, release, arrived
    await page.route(url => url.pathname === sessionPath, async route => {
      if (route.request().method() !== 'POST') return route.continue()
      const body = route.request().postDataJSON(), response = await route.fetch(), data = await response.json()
      posts.push({ name, body, status: response.status(), data })
      if (lose) { lose = false; await route.abort('failed'); return }
      if (hold) { arrived(); await new Promise(resolve => { release = resolve }) }
      await route.fulfill({ response })
    })
    step = `${name}: explicit selection and lost response`
    await page.goto(path(task.id)); await create.waitFor()
    check(await create.isDisabled(), `${name}: creation requires explicit environment, no implicit assignment`)
    await choose()
    assert.equal(await environment.locator('option').count(), 3)
    await title.fill(`初始会话 ${name}`); await create.click()
    const retry = surface.getByRole('button', { name: '重试原会话请求', exact: true })
    await retry.waitFor()
    const first = posts.at(-1)
    assert.equal(first.status, 201); assert.equal(first.data.created, true)
    const pending = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('wemux.task-session:')))
    assert.equal(pending.length, 1); assert.deepEqual(JSON.parse(pending[0][1]), first.body)
    await title.fill('不应覆盖原请求'); await choose('second')
    check(await create.isDisabled(), `${name}: pending request blocks new creation after field changes`)
    await page.screenshot({ path: join(evidence, `${name}-pending.png`), fullPage: true })
    await owner.api(`/sessions/${first.data.session.id}`, 'PATCH', { title: `服务端改名 ${name}` })
    await owner.api(`/sessions/${first.data.session.id}/runtime/commands`, 'POST', { commandId: `model-change-${name}`, name: 'set_model', arguments: { modelId: 'second' } })
    // 准入不构成已确认的模型变更：模拟 Worker 有序 model.changed Journal 事件落地投影
    await app.store.transaction(async tx => {
      const staged = await tx.resources.getSession(first.data.session.id)
      await tx.resources.saveSession({ ...staged, binding: { ...staged.binding, modelId: 'second' } })
    })
    await page.reload(); await retry.click()
    await surface.getByText('已确认会话：', { exact: false }).waitFor()
    const replay = posts.at(-1)
    assert.deepEqual(replay.body, first.body); assert.equal(replay.data.created, false); assert.equal(replay.data.session.id, first.data.session.id); assert.equal(replay.data.commandId, first.data.commandId)
    assert.equal(replay.data.session.title, `服务端改名 ${name}`); assert.equal(replay.data.session.binding.modelId, 'second')
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('wemux.task-session:')).length), 0)
    check(true, `${name}: reload identical retry reconciles same Session/command despite changed current fields/title/model`)
    step = `${name}: second Session and list`
    await choose('second'); await title.fill(`第二会话 ${name}`); await create.click()
    await surface.getByText('当前获权会话：2 个', { exact: true }).waitFor()
    assert.equal(await surface.locator('[data-session-id]').count(), 2)
    assert.notEqual(posts.at(-1).body.requestId, first.body.requestId)
    const unchanged = await owner.api(`/projects/${project.id}/tasks/${task.id}`)
    assert.equal(unchanged.assignee, null); assert.deepEqual(unchanged.workspaces, [])
    check((await owner.api(`/projects/${project.id}/tasks/${task.id}/runs`)).items.length === 0, `${name}: multiple Sessions without assignment/binding mutation or Run`)
    await page.screenshot({ path: join(evidence, `${name}-multiple.png`), fullPage: true })
    step = `${name}: late creation scope retirement`
    hold = true; const reached = new Promise(resolve => { arrived = resolve })
    await title.fill(`离开任务后的会话 ${name}`); await create.click(); await reached
    const late = posts.at(-1)
    await page.getByRole('button', { name: other.title, exact: true }).click()
    await surface.getByText('此任务暂无当前账号可见的会话。', { exact: true }).waitFor(); release()
    await page.waitForFunction(() => !Object.keys(sessionStorage).some(key => key.startsWith('wemux.task-session:')))
    assert.equal(await surface.getByText(late.data.session.id, { exact: false }).count(), 0)
    assert.equal(await surface.getByText('已确认会话：', { exact: false }).count(), 0)
    check(true, `${name}: late create response cannot update another Task`)
    hold = false
    step = `${name}: late discovery scope retirement`
    const responseMarker = `held-discovery-${name}`
    await page.evaluate(({ marker, pathname, negativeControl }) => {
      const originalJson = Response.prototype.json
      const state = { marker, consumed: false, uiProcessed: false, phases: [], sessionIds: [] }
      window.discoveryConsumption = state
      Response.prototype.json = function (...args) {
        if (new URL(this.url).pathname !== pathname || this.headers.get('x-wemux-test-discovery') !== marker) return originalJson.apply(this, args)
        // Only the actual application Response.json call can trigger this signal; route.fetch is outside the browser.
        Response.prototype.json = originalJson
        return originalJson.apply(this, args).then(body => {
          state.consumed = true; state.sessionIds = body.items.map(session => session.id); state.phases.push('application-json-resolved')
          // Returning the body lets transport validation and the awaiting hook drain their microtasks.
          // Two rendering opportunities plus a following browser task cover ensuing normal-priority React work.
          requestAnimationFrame(() => {
            state.phases.push('first-ui-frame')
            if (negativeControl) {
              const row = document.createElement('li'); row.dataset.sessionId = state.sessionIds[0]; row.dataset.discoveryNegativeControl = marker
              document.querySelector('section[aria-label="任务会话"]').append(row)
              state.phases.push('injected-stale-row')
            }
            requestAnimationFrame(() => {
              state.phases.push('second-ui-frame')
              const channel = new MessageChannel()
              channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); state.phases.push('post-frame-task'); state.uiProcessed = true }
              channel.port2.postMessage(null)
            })
          })
          return body
        })
      }
    }, { marker: responseMarker, pathname: sessionPath, negativeControl: discoveryNegativeControl })
    let listArrived, listRelease
    const listReached = new Promise(resolve => { listArrived = resolve })
    const listHandler = async route => {
      const response = await route.fetch(); listArrived(); await new Promise(resolve => { listRelease = resolve })
      await route.fulfill({ response, headers: { ...response.headers(), 'x-wemux-test-discovery': responseMarker } })
    }
    const listMatcher = url => url.pathname === sessionPath
    await page.route(listMatcher, listHandler)
    await page.getByRole('button', { name: task.title, exact: true }).click(); await listReached
    await page.getByRole('button', { name: other.title, exact: true }).click()
    await surface.getByText('此任务暂无当前账号可见的会话。', { exact: true }).waitFor(); listRelease()
    await page.waitForFunction(marker => window.discoveryConsumption?.marker === marker && window.discoveryConsumption.uiProcessed, responseMarker)
    const barrier = await page.evaluate(() => window.discoveryConsumption)
    assert.equal(barrier.consumed, true); assert.ok(barrier.sessionIds.includes(late.data.session.id))
    const staleRows = await surface.locator('[data-session-id]').count()
    discoveryBarriers.push({ name, ...barrier, staleRows, negativeControl: discoveryNegativeControl })
    await writeFile(join(evidence, 'discovery-barriers.json'), JSON.stringify(discoveryBarriers, null, 2))
    // Remove only the injected test row so both viewports can exercise the same negative control.
    if (discoveryNegativeControl) await surface.locator('[data-discovery-negative-control]').evaluateAll(rows => rows.forEach(row => row.remove()))
    else assert.equal(staleRows, 0, 'consumed old Task discovery must not render in the current Task')
    await page.unroute(listMatcher, listHandler)
    if (!discoveryNegativeControl) check(true, `${name}: consumed delayed discovery plus ensuing UI frames/task cannot disclose old Task Sessions`)
    step = `${name}: storage denial sends no POST`
    await choose(); const before = posts.length
    await page.evaluate(() => { window.originalSessionSet = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith('wemux.task-session:')) throw Error('test denied'); return window.originalSessionSet.call(this, key, value) } })
    let otherPosts = 0
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/projects/${project.id}/tasks/${other.id}/sessions`) otherPosts++ })
    await create.click(); await surface.getByRole('alert').filter({ hasText: '无法保存创建请求' }).waitFor()
    assert.equal(otherPosts, 0); assert.equal(posts.length, before)
    await page.evaluate(() => { Storage.prototype.setItem = window.originalSessionSet; delete window.originalSessionSet })
    check(true, `${name}: denied sessionStorage persistence fails before POST`)
    step = `${name}: real server permission/availability error and immutable retry`
    await app.store.transaction(async tx => { const worker = await tx.resources.getWorker(selection.workerId); await tx.resources.saveWorker({ ...worker, capabilities: worker.capabilities.map(agent => ({ ...agent, availability: { status: 'unavailable' } })) }) })
    await create.click(); await retry.waitFor(); await surface.getByRole('alert').waitFor()
    assert.equal(otherPosts, 1)
    await app.store.transaction(async tx => { const worker = await tx.resources.getWorker(selection.workerId); await tx.resources.saveWorker({ ...worker, capabilities: worker.capabilities.map(agent => ({ ...agent, availability: { status: agent.agentKey === selection.agentKey ? 'available' : 'unavailable' } })) }) })
    await retry.click(); await surface.getByText('当前获权会话：1 个', { exact: true }).waitFor()
    check(otherPosts === 2, `${name}: server rejects stale environment and original request recovers after restoration`)
    step = `${name}: discovery error recovery`
    const otherSessionPath = `/api/projects/${project.id}/tasks/${other.id}/sessions`
    let failRead = true
    const failureMatcher = url => url.pathname === otherSessionPath
    const failureHandler = async route => {
      if (failRead && route.request().method() === 'GET') { failRead = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'controlled discovery failure' } }) }) }
      return route.continue()
    }
    await page.route(failureMatcher, failureHandler)
    await surface.getByRole('button', { name: '刷新任务会话', exact: true }).click()
    await surface.getByRole('alert').waitFor()
    assert.equal(await surface.locator('[data-session-id]').count(), 0)
    await surface.getByRole('button', { name: '重试', exact: true }).click()
    await surface.getByText('当前获权会话：1 个', { exact: true }).waitFor()
    await page.unroute(failureMatcher, failureHandler)
    check(true, `${name}: discovery failure clears stale list and offers successful explicit retry`)
    step = `${name}: deleted Task`
    await page.goto(path(deleted.id)); await surface.getByText('任务已删除，不能创建会话。', { exact: true }).waitFor()
    assert.equal(await create.count(), 0)
    check(true, `${name}: deleted Task cannot create`)
    step = `${name}: read-only discovery and authorization filtering`
    // One owner-only Session must not contribute a title or count for the viewer.
    await owner.api(`/sessions/${first.data.session.id}/access`, 'PATCH', { shareScope: 'owner-only' })
    const readOnly = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    assert.equal((await readOnly.request.post(`${origin}/api/auth/login`, { data: { login: viewerEmail, password } })).status(), 200)
    const view = await readOnly.newPage(); view.setDefaultTimeout(12000); view.on('pageerror', e => errors.push(`${name} viewer: ${e.message}`))
    await view.goto(path(task.id)); const viewerSurface = view.getByRole('region', { name: '任务会话', exact: true })
    await viewerSurface.getByText('当前获权会话：2 个', { exact: true }).waitFor()
    assert.equal(await viewerSurface.getByRole('button', { name: '创建任务会话', exact: true }).count(), 0)
    assert.equal(await viewerSurface.getByText(`服务端改名 ${name}`, { exact: true }).count(), 0)
    await viewerSurface.getByText('当前为只读权限，可查看获权会话，不能创建。', { exact: true }).waitFor()
    check(true, `${name}: viewer sees authorized Sessions only, no create action or hidden title/count`)
    await viewerSurface.screenshot({ path: join(evidence, `${name}-readonly.png`) })
    await readOnly.close()
    step = `${name}: stale remounted original retry`
    const remountTask = await owner.api(`/projects/${project.id}/tasks`, 'POST', { title: `重挂载任务 ${name}`, requestId: `remount-${name}` })
    const remountPath = `/api/projects/${project.id}/tasks/${remountTask.id}/sessions`
    const remountPosts = []
    let releaseRemount, remountArrived
    const remountReached = new Promise(resolve => { remountArrived = resolve })
    await page.route(url => url.pathname === remountPath, async route => {
      if (route.request().method() !== 'POST') return route.continue()
      const response = await route.fetch(), data = await response.json()
      remountPosts.push({ body: route.request().postDataJSON(), data })
      if (remountPosts.length === 1) { remountArrived(); await new Promise(resolve => { releaseRemount = resolve }) }
      await route.fulfill({ response })
    })
    await page.goto(path(remountTask.id)); await choose(); await title.fill(`原始重挂载请求 ${name}`)
    await create.click(); await remountReached
    const original = remountPosts[0]
    const persisted = await page.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith('wemux.task-session:')))
    assert.deepEqual(JSON.parse(persisted[1]), original.body)
    // Actual SPA unmount/remount while the original component still awaits success.
    await page.getByRole('button', { name: other.title, exact: true }).click()
    await surface.getByText(`固定归属：${other.title}。`, { exact: false }).waitFor()
    await page.getByRole('button', { name: remountTask.title, exact: true }).click()
    await retry.waitFor()
    await surface.getByText(`请求标识：${original.body.requestId}`, { exact: true }).waitFor()
    releaseRemount()
    // Removal proves the old PendingTaskSession succeeded; a subsequent task drains its finally microtask.
    await page.waitForFunction(key => sessionStorage.getItem(key) === null, persisted[0])
    await page.evaluate(() => Promise.resolve())
    await retry.waitFor()
    await choose('second'); await title.fill(`不得成为新请求 ${name}`)
    const commandsBefore = (await app.store.commands.list({ limit: 1000 })).length
    const refresh = page.waitForResponse(response => new URL(response.url()).pathname === remountPath && response.request().method() === 'GET')
    await retry.click(); await refresh
    await retry.waitFor({ state: 'hidden' })
    await surface.locator(`[data-session-id="${original.data.session.id}"]`).waitFor()
    const discovered = await owner.api(`/projects/${project.id}/tasks/${remountTask.id}/sessions`)
    const commandsAfter = (await app.store.commands.list({ limit: 1000 })).length
    const outcome = { name, posts: [...remountPosts], commandsBefore, commandsAfter, discoveredIds: discovered.items.map(session => session.id) }
    remountRetries.push(outcome)
    // Collect both desktop and mobile failures before asserting, preserving deterministic red evidence.
    outcome.passed = remountPosts.length === 1 && commandsAfter === commandsBefore && discovered.items.length === 1 && discovered.items[0].id === original.data.session.id
    await page.screenshot({ path: join(evidence, `${name}-remount-retry.png`), fullPage: true })
    if (outcome.passed) {
      step = `${name}: mismatched persisted identity`
      // Simulate another same-tab view replacing the stored intent after this view snapshots it.
      await page.evaluate(([key, body]) => sessionStorage.setItem(key, JSON.stringify(body)), [persisted[0], original.body])
      await page.reload(); await retry.waitFor()
      await surface.getByText('仅支持当前标签页刷新后恢复；关闭标签页或清除浏览器存储后不保证恢复，不保证跨标签页去重。', { exact: true }).waitFor()
      const newer = { ...original.body, requestId: `newer-pending-${name}`, title: `另一待确认请求 ${name}` }
      await page.evaluate(([key, body]) => sessionStorage.setItem(key, JSON.stringify(body)), [persisted[0], newer])
      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === remountPath && response.request().method() === 'GET')
      await retry.click(); await refreshed
      await surface.getByText(`请求标识：${newer.requestId}`, { exact: true }).waitFor()
      assert.equal(remountPosts.length, 1)
      assert.equal((await app.store.commands.list({ limit: 1000 })).length, commandsBefore)
      assert.deepEqual(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), persisted[0]), newer)
      check(true, `${name}: stale retry does not send or erase a mismatched newer persisted identity; same-tab limits disclosed`)
      // This is a now-explicit retry of the newly displayed identity, not a stale click.
      await retry.click(); await surface.getByText('当前获权会话：2 个', { exact: true }).waitFor()
      assert.equal(remountPosts.length, 2); assert.deepEqual(remountPosts[1].body, newer)
      step = `${name}: retry joins still-active remounted operation`
      let joinArrived, joinRelease
      const joinReached = new Promise(resolve => { joinArrived = resolve })
      const joinMatcher = url => url.pathname === remountPath
      let joinPosts = 0
      const joinHandler = async route => {
        if (route.request().method() !== 'POST') return route.continue()
        joinPosts++; const response = await route.fetch(); joinArrived()
        await new Promise(resolve => { joinRelease = resolve }); await route.fulfill({ response })
      }
      await page.route(joinMatcher, joinHandler)
      await choose(); await title.fill(`共享活动请求 ${name}`); await create.click(); await joinReached
      await page.getByRole('button', { name: other.title, exact: true }).click()
      await surface.getByText(`固定归属：${other.title}。`, { exact: false }).waitFor()
      await page.getByRole('button', { name: remountTask.title, exact: true }).click()
      await retry.click(); await surface.getByText('正在核对创建结果…', { exact: true }).waitFor()
      const joinedCommands = (await app.store.commands.list({ limit: 1000 })).length
      joinRelease()
      await retry.waitFor({ state: 'hidden' }); await surface.getByText('已确认会话：', { exact: false }).waitFor()
      await surface.getByText('当前获权会话：3 个', { exact: true }).waitFor()
      assert.equal(joinPosts, 1); assert.equal((await app.store.commands.list({ limit: 1000 })).length, joinedCommands)
      await page.unroute(joinMatcher, joinHandler)
      check(true, `${name}: retry joins still-active same-scope operation without duplicate POST/command`)
    }
    await context.close()
  }
  await writeFile(join(evidence, 'remount-retries.json'), JSON.stringify(remountRetries, null, 2))
  assert.ok(remountRetries.every(result => result.passed), 'stale original retry must send zero new POST/requestId/command on desktop and mobile')
  for (const result of remountRetries) check(result.passed, `${result.name}: settled remounted retry reconciles original Session with zero new POST/requestId/command`)
  assert.ok(discoveryBarriers.every(result => result.staleRows === 0), 'consumed old Task discovery must not render in the current Task (desktop/mobile oracle)')
  assert.deepEqual(errors, [])
  // Deliberately aborted/lost response and real rejection produce browser network diagnostics only.
  const unexpectedConsoleErrors = consoleErrors.filter(entry => !/Failed to load resource: (net::ERR_FAILED|the server responded with a status of (409|400|410|503))/.test(entry.text))
  assert.deepEqual(unexpectedConsoleErrors, [])
  check(true, 'desktop/mobile: no page errors or unexpected console errors')
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, checks, posts, remountRetries, discoveryBarriers, errors, consoleErrors, origin, runtime: 'UI/Server integration only; synthetic capabilities; no Worker or Runtime', screenshots: 'captured, not visually approved' }, null, 2))
  console.log(`Next Task Session acceptance passed (${checks.length} checks): ${evidence}`)
} catch (error) {
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ step, checks, errors, consoleErrors, error: String(error.stack ?? error) }, null, 2)); console.error(`Browser failure at ${step}: ${evidence}`); throw error
} finally {
  await browser?.close(); await app.close()
  // Keep assertions/screenshots only. Test accounts/cookies and the owned database are not evidence.
  for (const suffix of ['', '-wal', '-shm']) await rm(join(evidence, `server.sqlite${suffix}`), { force: true })
  await writeFile(join(evidence, 'cleanup.json'), JSON.stringify({ browserClosed: true, serverClosed: true, databaseRemoved: true }))
}
