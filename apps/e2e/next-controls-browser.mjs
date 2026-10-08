/** Actual Next + owned Server HTTP, synthetic Worker capabilities, no Runtime execution.
 * Requires frozen /tmp WEMUX_NEXT_TEST_DIST and explicit installed Playwright paths.
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createWemuxServer } from '../server/src/server.ts'
import { WorkerService } from '../server/src/application/worker-service.ts'
import { Notifications } from '../server/src/application/notifications.ts'
import { provisionAdministrator, login } from './session.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { launchAcceptanceBrowser } from '../web-next/tests/acceptance-runtime.mjs'
assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'))
const evidence = await mkdtemp(join(tmpdir(), 'wemux-next-controls-browser-'))
const email = 'controls-owner@example.test', viewerEmail = 'controls-viewer@example.test', password = 'synthetic-controls-password'
const app = createWemuxServer({ databasePath: join(evidence, 'server.sqlite'), administratorEmails: [email], mail: {}, google: {}, webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST) })
const origin = await app.listen(0), checks = [], errors = [], posts = [], receiptReads = []
let browser, lastPage, step = 'setup'
const check = (ok, label) => { assert.ok(ok, label); checks.push(label) }
// Never persist headers, cookies, capability objects, login secrets or raw Playwright call logs.
const redact = text => text.replaceAll(password, '[redacted]').replace(/(Bearer\s+)[^\s"<>]+/gi, '$1[redacted]').replace(/((?:csrfToken|capabilityToken|accessToken|token|cookie)\s*[=:]\s*["']?)[^\s"'<>]+/gi, '$1[redacted]')
try {
  const owner = await provisionAdministrator({ store: app.store, baseUrl: origin, email, password }); await owner.api('/bootstrap', 'POST', {})
  const viewerAccount = await seedLocalAccount(app.store, { username: viewerEmail, email: viewerEmail, password })
  const viewer = await login(origin, viewerEmail, password)
  const invite = await owner.api('/teams/default-team/invitations', 'POST', { email: viewerEmail }); await viewer.api(`/team-invitations/${invite.token}/accept`, 'POST', {})
  const team2 = await owner.api('/teams', 'POST', { name: '隔离团队' })
  browser = await launchAcceptanceBrowser()
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    step = `${name}: fixture`
    const fixture = async (teamId, suffix) => {
      const project = await owner.api('/projects', 'POST', { name: `消息验收 ${name} ${suffix}`, teamId, requestId: `p-${name}-${suffix}` }); await owner.api(`/projects/${project.id}/access`, 'PATCH', { shareScope: 'team' })
      const task = await owner.api(`/projects/${project.id}/tasks`, 'POST', { title: `消息任务 ${suffix}`, requestId: `t-${name}-${suffix}` })
      const other = await owner.api(`/projects/${project.id}/tasks`, 'POST', { title: `另一任务 ${suffix}`, requestId: `o-${name}-${suffix}` })
      const selection = { workspaceId: `w-${name}-${suffix}`, workerId: `node-${name}-${suffix}`, agentKey: 'synthetic', modelId: 'fixture/model' }
      await app.store.transaction(async tx => {
        await tx.resources.saveWorker({ id: selection.workerId, teamId, ownerId: project.ownerId, name: '合成执行节点', shareScope: 'team', connectionState: 'online', version: '1', platform: 'linux', lastSeenAt: new Date().toISOString(), capabilities: [{ agentKey: 'synthetic', displayName: '合成 Agent', mode: 'execution', availability: { status: 'available' }, modelSwap: true, models: [{ modelId: selection.modelId, displayName: '合成模型', source: 'configured' }, { modelId: 'fixture/next', displayName: '后续模型', source: 'configured' }] }] })
        await tx.resources.saveWorkspace({ id: selection.workspaceId, projectId: project.id, name: '消息工作区', spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [{ workerId: selection.workerId, status: 'ready', failureReason: null, location: null }], deletedAt: null })
      })
      const create = async (target, title) => (await owner.api(`/projects/${project.id}/tasks/${target.id}/sessions`, 'POST', { ...selection, title, requestId: `s-${name}-${suffix}-${title}` })).session
      return { project, task, other, selection, session: await create(task, '主会话'), second: await create(task, '第二会话'), otherSession: await create(other, '其他任务会话') }
    }
    const f = await fixture('default-team', 'default'), secondTeam = await fixture(team2.id, 'second')
    // Synthetic execution projection only: no Worker or native Runtime executes commands.
    const enqueue = async (fixture, id) => owner.api(`/sessions/${fixture.session.id}/messages`, 'POST', { commandId: `${name}-${id}`, messageId: `${name}-message-${id}`, content: `保留队列 ${id}` })
    for (const id of ['active', 'one', 'two']) await enqueue(f, id)
    await owner.api(`/sessions/${f.second.id}/messages`, 'POST', { commandId: `${name}-denied`, content: '仅验证存储拒绝' })
    let seq = 0
    const events = async payloads => app.store.transaction(tx => tx.cache.applyEvents(f.session.id, payloads.map(payload => ({ sessionId: f.session.id, seq: ++seq, occurredAt: new Date().toISOString(), payload }))))
    await events([{ kind: 'message.queued', commandId: `${name}-active`, messageId: `${name}-message-active`, content: 'active', position: 0, sentByAccountId: f.project.ownerId }, { kind: 'turn.started', turnId: `${name}-turn-one`, messageId: `${name}-message-active` }])
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    await context.addInitScript(() => {
      window.controlProbe = { mode: '', consumed: 0, settled: 0, deny: false, held: null }
      const json = Response.prototype.json
      Response.prototype.json = async function (...args) {
        const body = await json.apply(this, args)
        if (!/\/api\/sessions\/[^/]+\/(messages\/[^/]+\/cancel|turn\/stop|runtime\/approvals\/[^/]+|runtime\/commands)$/.test(new URL(this.url).pathname)) return body
        const probe = window.controlProbe, mode = probe.mode; probe.mode = ''; probe.consumed++
        if (mode === 'hold') { probe.held = { status: this.status, path: new URL(this.url).pathname, commandId: body.commandId }; await new Promise(resolve => { window.releaseControl = resolve }) }
        probe.settled++
        if (mode === 'lose') throw Error('Synthetic loss after actual HTTP response consumed')
        return body
      }
      const set = Storage.prototype.setItem
      Storage.prototype.setItem = function (key, value) { if (key.startsWith('wemux.conversation-controls:') && window.controlProbe.deny) throw Error('Synthetic persistence denial'); return set.call(this, key, value) }
    })
    assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: email, password } })).status(), 200)
    const page = await context.newPage(); lastPage = page; page.setDefaultTimeout(12000)
    page.on('pageerror', error => errors.push({ name, error: error.message }))
    page.on('request', request => { const path = new URL(request.url()).pathname; if (/\/api\/sessions\/[^/]+\/(messages\/[^/]+\/cancel|turn\/stop|runtime\/approvals\/[^/]+|runtime\/commands)$/.test(path) && request.method() === 'POST') posts.push({ name, path, body: request.postDataJSON() }); if (/\/api\/commands\//.test(path)) receiptReads.push(path) })
    const path = (fixture = f, task = fixture.task, session = fixture.session) => `/next/projects/${fixture.project.id}?task=${task.id}&session=${session.id}`
    const spa = async target => page.evaluate(target => { history.pushState({}, '', target); dispatchEvent(new Event('wemux:navigate')) }, target)
    const panel = page.getByRole('region', { name: '任务会话对话', exact: true }), controls = panel.getByRole('region', { name: '队列与 Turn 控制', exact: true })
    const cancel = id => controls.getByRole('button', { name: `取消排队消息 ${name}-${id}`, exact: true })
    const stop = () => controls.getByRole('button', { name: /^停止当前 Turn / }), retry = controls.getByRole('button', { name: '重试原控制请求', exact: true })
    const ready = async () => { await panel.getByText('已读取会话', { exact: true }).waitFor(); await controls.waitFor() }
    const settled = async () => { await page.waitForFunction(() => window.controlProbe.consumed === window.controlProbe.settled); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
    const admitted = async () => { await controls.getByText('控制请求已接收。', { exact: false }).waitFor(); await retry.waitFor({ state: 'hidden' }) }
    const durable = async sessionId => page.evaluate(sessionId => Object.entries(sessionStorage).filter(([key]) => key.startsWith('wemux.conversation-controls:')).map(([key, raw]) => ({ key, value: JSON.parse(raw) })).find(item => JSON.parse(item.key.slice('wemux.conversation-controls:'.length)).sessionId === sessionId), sessionId)
    const refresh = async () => { const response = page.waitForResponse(r => new URL(r.url()).pathname === `/api/sessions/${f.session.id}`); await panel.getByRole('button', { name: '刷新会话历史', exact: true }).click(); await response; await ready() }
    const details = async () => { const summaries = await app.store.commands.list({ workerId: f.selection.workerId, limit: 1000 }); assert.ok(summaries.length < 1000); return (await Promise.all(summaries.map(s => app.store.commands.getPendingCommand(s.commandId)))).filter(Boolean) }
    await page.goto(origin + path()); await ready()
    step = `${name}: persistence denial zero POST`
    const initial = posts.length
    await spa(path(f, f.task, f.second)); await ready()
    await page.evaluate(() => { window.controlProbe.deny = true }); await cancel('denied').click()
    await controls.getByRole('alert').waitFor(); assert.equal(posts.length, initial)
    await page.evaluate(() => { window.controlProbe.deny = false }); await controls.getByRole('button', { name: '重新读取控制请求存储', exact: true }).click()
    check(posts.length === initial, `${name}: persistence denial and explicit storage reload produce zero POST`)
    // A failed initial write retains the identity and fails closed; do not reset or invent recovery.
    await spa(path()); await ready()
    step = `${name}: exact cancel response lost, remount, blocking stop, original retry`
    await page.evaluate(() => { window.controlProbe.mode = 'lose' }); await cancel('one').click(); await retry.waitFor()
    const first = posts.at(-1), pending = await durable(f.session.id)
    assert.deepEqual(Object.keys(first.body), ['commandId']); assert.equal(first.path, `/api/sessions/${f.session.id}/messages/${name}-one/cancel`)
    assert.equal(pending.value.receipt, null); assert.ok(await stop().isDisabled()); assert.ok(await cancel('two').isDisabled())
    await spa(path(f, f.task, f.second)); await ready(); await spa(path()); await ready(); await retry.waitFor(); assert.equal(posts.length, initial + 1)
    await owner.api(`/sessions/${f.session.id}`, 'PATCH', { archived: true }); await refresh(); assert.ok(await retry.isDisabled())
    await owner.api(`/sessions/${f.session.id}`, 'PATCH', { archived: false }); await refresh()
    // Hold metadata independently; ready authority must not survive the refresh interval.
    await page.evaluate(path => { const json = Response.prototype.json; window.metadataHeld = false; Response.prototype.json = async function (...args) { const body = await json.apply(this, args); if (new URL(this.url).pathname !== path) return body; Response.prototype.json = json; window.metadataHeld = true; await new Promise(resolve => { window.releaseMetadata = resolve }); return body } }, `/api/sessions/${f.session.id}`)
    await panel.getByRole('button', { name: '刷新会话历史', exact: true }).click(); await page.waitForFunction(() => window.metadataHeld); assert.ok(await retry.isDisabled()); assert.ok(await stop().isDisabled()); await page.evaluate(() => window.releaseMetadata()); await ready()
    await retry.click(); await admitted(); assert.deepEqual(posts.at(-1), first)
    assert.equal((await details()).filter(d => d.commandId === first.body.commandId).length, 1)
    await cancel('one').waitFor(); await cancel('two').waitFor()
    check(true, `${name}: exact enqueue-command cancel, lost actual response and same-ID/body explicit remount retry; pending cancel blocks stop/new target; archive/stale metadata deny; admission retains queue`)
    step = `${name}: explicit stop retry after next Turn`
    await page.evaluate(() => { window.controlProbe.mode = 'lose' }); await stop().click(); await retry.waitFor()
    const firstStop = posts.at(-1); assert.deepEqual(Object.keys(firstStop.body).sort(), ['commandId', 'turnId']); assert.equal(firstStop.body.turnId, `${name}-turn-one`)
    await events([{ kind: 'turn.finished', turnId: `${name}-turn-one`, outcome: 'completed', failure: null }, { kind: 'turn.started', turnId: `${name}-turn-two`, messageId: `${name}-message-active` }]); await refresh()
    assert.ok(await stop().isDisabled()); await retry.click(); await admitted(); assert.deepEqual(posts.at(-1), firstStop)
    check(true, `${name}: original stop retains old Turn after synthetic next-Turn projection, never clears queue`)
    step = `${name}: approval loss retry and terminal expiration`
    await events([{ kind: 'approval.requested', turnId: `${name}-turn-two`, approvalId: 'approval-ui', action: { tool: 'fixture-write' }, reason: '审批验收' }]); await refresh()
    const approvalPanel = controls.getByRole('region', { name: '工具审批', exact: true })
    await page.evaluate(() => { window.controlProbe.mode = 'lose' }); await approvalPanel.getByRole('button', { name: '拒绝操作', exact: true }).click(); await retry.waitFor()
    const approvalPost = posts.at(-1)
    assert.equal(approvalPost.path, `/api/sessions/${f.session.id}/runtime/approvals/approval-ui`)
    assert.deepEqual(approvalPost.body, { commandId: approvalPost.body.commandId, turnId: `${name}-turn-two`, decision: 'deny' })
    assert.ok(await approvalPanel.getByRole('button', { name: '批准操作', exact: true }).isDisabled())
    const approvalPosts = posts.length
    await spa(path(f, f.task, f.second)); await ready(); await spa(path()); await ready(); await retry.waitFor()
    assert.equal(posts.length, approvalPosts, 'approval remount must not automatically replay even the same identity')
    await retry.click(); await admitted(); assert.equal(posts.length, approvalPosts + 1); assert.deepEqual(posts.at(-1), approvalPost)
    assert.equal((await details()).filter(d => d.commandId === approvalPost.body.commandId).length, 1)
    await events([{ kind: 'approval.resolved', turnId: `${name}-turn-two`, approvalId: 'approval-ui', decision: 'deny' }, { kind: 'approval.requested', turnId: `${name}-turn-two`, approvalId: 'expires-ui', action: { tool: 'fixture' } }]); await refresh()
    await approvalPanel.getByRole('button', { name: '批准操作', exact: true }).waitFor()
    const beforeExpiryPosts = posts.length
    for (const reason of ['timeout', 'cancelled', 'turn_released', 'shutdown']) {
      if (reason !== 'timeout') { await events([{ kind: 'approval.requested', turnId: `${name}-turn-two`, approvalId: `expires-${reason}`, action: { tool: 'fixture' } }]); await refresh(); await approvalPanel.getByRole('button', { name: '批准操作', exact: true }).waitFor() }
      const approvalId = reason === 'timeout' ? 'expires-ui' : `expires-${reason}`
      await events([{ kind: 'approval.expired', turnId: `${name}-turn-two`, approvalId, reason }]); await refresh()
      await approvalPanel.getByText('没有待决审批。', { exact: true }).waitFor()
      await panel.getByText(new RegExp(`审批已失效：${approvalId}`)).waitFor()
      await page.reload(); await ready()
      await approvalPanel.getByText('没有待决审批。', { exact: true }).waitFor()
      assert.equal(posts.length, beforeExpiryPosts, 'automatic expiry and reload never submit a human decision')
    }
    check(true, `${name}: all four automatic expiry reasons remove controls during active Turn and survive reload, zero decision POST`)
    // Reload deliberately distrusts stored admission. Explicitly revalidate the
    // earlier human decision before starting unrelated model controls.
    await retry.click(); await admitted(); assert.deepEqual(posts.at(-1), approvalPost)
    await events([{ kind: 'turn.finished', turnId: `${name}-turn-two`, outcome: 'completed', failure: null }, { kind: 'turn.started', turnId: `${name}-turn-three`, messageId: `${name}-message-active`, modelId: 'fixture/model' }]); await refresh()
    await approvalPanel.getByText('没有待决审批。', { exact: true }).waitFor()
    check(true, `${name}: approval exact decision/Turn persists after lost HTTP response; retry one command; authoritative resolution and Turn expiration remove controls`)
    step = `${name}: immutable model selection admission and history`
    const modelPanel = controls.getByRole('region', { name: '模型选择', exact: true }), modelSubmit = modelPanel.getByRole('button', { name: '应用到后续 Turn', exact: true })
    step = `${name}: withdrawn model rejection and explicit release`
    const discoveredWorker = await app.store.resources.getWorker(f.selection.workerId)
    assert.ok(discoveredWorker)
    await modelPanel.getByRole('combobox', { name: '选择后续模型', exact: true }).selectOption('fixture/next')
    await app.store.transaction(tx => tx.resources.saveWorker({ ...discoveredWorker, capabilities: discoveredWorker.capabilities.map(c => ({ ...c, models: c.models.filter(m => m.modelId !== 'fixture/next') })) }))
    await modelSubmit.click()
    const releaseRejected = controls.getByRole('button', { name: '释放未接收的模型请求', exact: true })
    await releaseRejected.waitFor()
    const rejectedModel = posts.at(-1), rejectedCount = posts.length
    assert.equal(await app.store.commands.get(rejectedModel.body.commandId), null)
    await controls.getByText('服务器明确未接收模型选择', { exact: false }).waitFor()
    assert.ok(await stop().isDisabled())
    await page.reload(); await ready(); await retry.waitFor()
    assert.equal(posts.length, rejectedCount, 'reload does not replay a rejected intent or trust persisted rejection')
    assert.equal(await releaseRejected.count(), 0)
    await retry.click(); await releaseRejected.waitFor(); assert.deepEqual(posts.at(-1), rejectedModel)
    await releaseRejected.click(); assert.equal(await stop().isEnabled(), true)
    await stop().click(); await admitted()
    assert.equal(posts.at(-1).body.turnId, `${name}-turn-three`)
    await app.store.transaction(tx => tx.resources.saveWorker(discoveredWorker))
    await modelPanel.getByRole('button', { name: '刷新模型清单', exact: true }).click()
    check(true, `${name}: withdrawn discovered model is definitively not admitted; explicit release restores stop; reload requires same-identity rejection verification, never auto-replays`)
    step = `${name}: select model option`
    const modelSelect = modelPanel.getByLabel('选择后续模型', { exact: true })
    assert.equal(await modelSelect.count(), 1, 'model label must identify exactly one select independently of option text')
    await modelSelect.selectOption('fixture/next')
    assert.equal(await modelSelect.inputValue(), 'fixture/next', 'selected model is retained before dispatch')
    step = `${name}: dispatch selected model`
    await page.evaluate(() => { window.controlProbe.mode = 'lose' }); await modelSubmit.click()
    step = `${name}: await uncertain model receipt`
    await retry.waitFor()
    const modelPost = posts.at(-1), modelPosts = posts.length
    assert.deepEqual(modelPost.body, { commandId: modelPost.body.commandId, name: 'set_model', arguments: { modelId: 'fixture/next' } })
    assert.ok(await stop().isDisabled()); assert.ok(await modelSubmit.isDisabled())
    await modelPanel.getByText('已确认选择：fixture/model。', { exact: false }).waitFor()
    await page.reload(); await ready(); await retry.waitFor(); assert.equal(posts.length, modelPosts, 'model reload never auto-dispatches')
    await owner.api(`/sessions/${f.session.id}`, 'PATCH', { archived: true }); await refresh(); assert.ok(await retry.isDisabled()); assert.equal(posts.length, modelPosts)
    await owner.api(`/sessions/${f.session.id}`, 'PATCH', { archived: false }); await refresh()
    await retry.click(); await admitted(); assert.equal(posts.length, modelPosts + 1); assert.deepEqual(posts.at(-1), modelPost)
    await modelPanel.getByText('已确认选择：fixture/model。', { exact: false }).waitFor()
    assert.equal((await details()).filter(d => d.commandId === modelPost.body.commandId).length, 1)
    // Synthetic Worker journal enters the production projector; this is not native execution.
    await new WorkerService(app.store, new Notifications()).receive(f.selection.workerId, { type: 'sync', kind: 'batch', sessionId: f.session.id, throughSeq: ++seq, hasMore: false, events: [{ sessionId: f.session.id, seq, occurredAt: new Date().toISOString(), payload: { kind: 'model.changed', previousModelId: 'fixture/model', modelId: 'fixture/next' } }] })
    await refresh(); await modelPanel.getByText('已确认选择：fixture/next。', { exact: false }).waitFor()
    await panel.getByText('固定模型：fixture/model', { exact: false }).waitFor()
    check(true, `${name}: model lost response and full reload preserve exact command; no automatic POST; archive denies retry; admission leaves model unchanged; only ordered Worker event confirms selection`)
    step = `${name}: duplicate click one identity`
    const beforeDuplicate = posts.length
    await page.evaluate(() => { window.controlProbe.mode = 'hold' }); await cancel('two').evaluate(button => { button.click(); button.click() })
    await page.waitForFunction(() => window.controlProbe.consumed > window.controlProbe.settled)
    assert.equal(posts.length, beforeDuplicate + 1); await page.evaluate(() => window.releaseControl()); await admitted()
    check(true, `${name}: double click causes one POST`)
    // Separate held successful HTTP responses are released only AFTER each replacement.
    for (const change of ['Session', 'Task', 'team', 'account']) {
      step = `${name}: independent ${change} late response`
      await page.evaluate(() => { window.controlProbe.mode = 'hold' }); await cancel('one').click()
      await page.waitForFunction(() => window.controlProbe.consumed > window.controlProbe.settled)
      const held = await durable(f.session.id), heldHttp = await page.evaluate(() => window.controlProbe.held); assert.equal(heldHttp.status, 202)
      if (change === 'Session') { await page.getByRole('button', { name: '查看会话：第二会话', exact: true }).click(); await ready() }
      if (change === 'Task') { await page.getByRole('button', { name: f.other.title, exact: true }).click(); await page.getByRole('button', { name: '查看会话：其他任务会话', exact: true }).click(); await ready() }
      if (change === 'team') {
        await spa('/next/teams'); await page.getByRole('combobox', { name: '查看团队', exact: true }).selectOption(team2.id); await page.getByRole('button', { name: '将此团队设为当前项目范围', exact: true }).click()
        await spa('/next/projects'); await page.getByRole('link', { name: new RegExp(secondTeam.project.name) }).waitFor(); await spa(path(secondTeam)); await ready()
      }
      const logout = async () => { if (name === 'mobile') await page.getByRole('button', { name: '打开导航', exact: true }).click(); await page.getByRole('button', { name: '退出登录', exact: true }).click(); await page.getByRole('heading', { name: '登录控制台', exact: true }).waitFor() }
      const loginUI = async login => { await page.getByLabel('邮箱或用户名', { exact: true }).fill(login); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click(); await ready() }
      if (change === 'account') { await logout(); await loginUI(viewerEmail); assert.equal(await cancel('one').isDisabled(), true) }
      const destination = await controls.innerText(), beforeRelease = posts.length
      await page.evaluate(() => window.releaseControl()); await settled()
      assert.equal(await controls.innerText(), destination); assert.deepEqual(await durable(f.session.id), held); assert.equal(posts.length, beforeRelease)
      assert.equal(await controls.getByRole('region', { name: '原控制请求', exact: true }).count(), 0)
      await writeFile(join(evidence, `${name}-${change}-late.json`), JSON.stringify({ heldHttp, original: held.value.intent, destinationUnchanged: true, originalReceipt: null, automaticPosts: 0 }, null, 2))
      if (change === 'team') { await spa('/next/teams'); await page.getByRole('combobox', { name: '查看团队', exact: true }).selectOption('default-team'); await page.getByRole('button', { name: '将此团队设为当前项目范围', exact: true }).click(); await spa('/next/projects'); await page.getByRole('link', { name: new RegExp(f.project.name) }).waitFor() }
      if (change === 'account') { await controls.screenshot({ path: join(evidence, `${name}-readonly.png`) }); await logout(); await loginUI(email) }
      await spa(path()); await ready(); await retry.waitFor(); assert.equal(posts.length, beforeRelease)
      await retry.click(); await admitted(); assert.equal(posts.at(-1).body.commandId, held.value.intent.body.commandId)
      check(true, `${name}: ${change} replacement precedes independent held HTTP202 release; no destination leak/old settlement/autosend; explicit original retry`)
    }
    step = `${name}: contributor own-target and live role changes`
    const viewerId = viewerAccount.id
    await app.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: f.project.id, userId: viewerId, role: 'contributor' }))
    await viewer.api(`/sessions/${f.session.id}/messages`, 'POST', { commandId: `${name}-viewer-own`, messageId: `${name}-viewer-message`, content: '参与者自己的队列消息' })
    if (name === 'mobile') await page.getByRole('button', { name: '打开导航', exact: true }).click()
    await page.getByRole('button', { name: '退出登录', exact: true }).click(); await page.getByRole('heading', { name: '登录控制台', exact: true }).waitFor()
    await page.getByLabel('邮箱或用户名', { exact: true }).fill(viewerEmail); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click(); await ready()
    assert.ok(await cancel('one').isDisabled()); assert.ok(await stop().isDisabled()); assert.equal(await cancel('viewer-own').isDisabled(), false)
    await page.evaluate(() => { window.controlProbe.mode = 'lose' }); await cancel('viewer-own').click(); await retry.waitFor(); const ownPost = posts.at(-1), rolePosts = posts.length
    await app.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: f.project.id, userId: viewerId, role: 'viewer' })); await refresh(); assert.ok(await retry.isDisabled()); assert.ok(await cancel('viewer-own').isDisabled()); assert.equal(posts.length, rolePosts)
    await app.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: f.project.id, userId: viewerId, role: 'contributor' })); await refresh(); await retry.click(); await admitted(); assert.deepEqual(posts.at(-1), ownPost)
    check(true, `${name}: contributor ownership uses server ID unequal to username; others denied; live viewer role denies original retry without POST; restored permission replays original`)
    await events([{ kind: 'turn.finished', turnId: `${name}-turn-two`, outcome: 'completed', failure: null }, { kind: 'message.queued', commandId: `${name}-viewer-own`, messageId: `${name}-viewer-message`, content: '自己的 Turn', position: 0, sentByAccountId: viewerId }, { kind: 'turn.started', turnId: `${name}-viewer-turn`, messageId: `${name}-viewer-message` }]); await refresh()
    assert.equal(await stop().isDisabled(), false)
    await page.evaluate(() => { window.controlProbe.mode = 'lose' }); await stop().click(); await retry.waitFor(); const ownStop = posts.at(-1), ownStopPosts = posts.length
    await events([{ kind: 'turn.finished', turnId: `${name}-viewer-turn`, outcome: 'completed', failure: null }, { kind: 'turn.started', turnId: `${name}-later-turn`, messageId: `${name}-message-active` }]); await refresh()
    assert.ok(await retry.isDisabled()); await controls.getByText('原目标已不可观察，无法核验自己的目标权限；', { exact: false }).waitFor(); assert.equal(posts.length, ownStopPosts)
    await app.store.transaction(tx => tx.identity.saveProjectGrant({ projectId: f.project.id, userId: viewerId, role: 'manager' })); await refresh(); await retry.click(); await admitted(); assert.deepEqual(posts.at(-1), ownStop)
    check(true, `${name}: contributor can stop own Turn; disappeared original target denies ownership-only retry; current manager retries exact old Turn`)
    const all = await details(), controlsStored = all.filter(d => ['session.cancel-queued', 'turn.stop', 'runtime.approval.resolve'].includes(d.command.kind) || d.command.kind === 'runtime.command' && d.command.name === 'set_model'), observedIds = new Set(posts.filter(p => p.name === name).map(p => p.body.commandId))
    assert.ok(observedIds.delete(rejectedModel.body.commandId), 'the rejected request was actually sent')
    assert.equal(await app.store.commands.get(rejectedModel.body.commandId), null, 'rejected intent must remain absent after later controls')
    assert.equal(controlsStored.length, observedIds.size); assert.deepEqual(new Set(controlsStored.map(d => d.commandId)), observedIds)
    for (const id of ['one', 'two']) assert.equal((await app.store.commands.get(`${name}-${id}`)).status, 'pending')
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: no horizontal overflow`)
    await controls.screenshot({ path: join(evidence, `${name}-controls.png`) })
    await writeFile(join(evidence, `${name}-commands.json`), JSON.stringify(controlsStored.map(d => ({ commandId: d.commandId, command: d.command })), null, 2))
    await context.close()
  }
  assert.deepEqual(errors, []); assert.deepEqual(receiptReads, [])
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, checks, posts, errors, receiptReads, chromium: browser.version(), evidence: 'Actual Next/shared client/Server, synthetic execution projections; no Worker/native Runtime proof. Screenshots are not visual approval.' }, null, 2))
  console.log(`Next controls browser passed (${checks.length} checks): ${evidence}`)
} catch (error) {
  if (lastPage && !lastPage.isClosed()) { await writeFile(join(evidence, 'failure-dom.html'), redact(await lastPage.content())); await writeFile(join(evidence, 'failure-accessibility.txt'), redact(await lastPage.locator('body').ariaSnapshot())) }
  await writeFile(join(evidence, 'failure.json'), redact(JSON.stringify({ step, checks, posts, errors, failure: { name: error.name, message: 'Assertion or browser wait failed; inspect redacted DOM/aria and bounded control network records.' } }, null, 2))); console.error(`Controls browser failed at ${step}: ${evidence}`); throw Error(`Controls acceptance failed: ${step}`)
} finally {
  await browser?.close(); await app.close()
  for (const file of ['server.sqlite', 'server.sqlite.transport']) for (const suffix of ['', '-wal', '-shm']) await rm(join(evidence, file + suffix), { force: true })
  await writeFile(join(evidence, 'cleanup.json'), JSON.stringify({ browserClosed: true, serverClosed: true, databaseRemoved: true }))
}
