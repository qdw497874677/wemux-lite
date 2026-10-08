/** Actual Next + owned Server HTTP, synthetic Worker capabilities, no Runtime execution.
 * Requires frozen /tmp WEMUX_NEXT_TEST_DIST and explicit installed Playwright paths.
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createWemuxServer } from '../server/src/server.ts'
import { provisionAdministrator, login } from './session.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { launchAcceptanceBrowser } from '../web-next/tests/acceptance-runtime.mjs'
assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'))
const evidence = await mkdtemp(join(tmpdir(), 'wemux-next-composer-browser-'))
const email = 'composer-owner@example.test', viewerEmail = 'composer-viewer@example.test', password = 'synthetic-composer-password'
const app = createWemuxServer({ databasePath: join(evidence, 'server.sqlite'), administratorEmails: [email], mail: {}, google: {}, webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST) })
const origin = await app.listen(0), checks = [], errors = [], posts = [], receiptReads = []
let browser, lastPage, step = 'setup'
const check = (ok, label) => { assert.ok(ok, label); checks.push(label) }
try {
  const owner = await provisionAdministrator({ store: app.store, baseUrl: origin, email, password }); await owner.api('/bootstrap', 'POST', {})
  await seedLocalAccount(app.store, { username: viewerEmail, email: viewerEmail, password })
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
        await tx.resources.saveWorker({ id: selection.workerId, teamId, ownerId: project.ownerId, name: '合成执行节点', shareScope: 'team', connectionState: 'online', version: '1', platform: 'linux', lastSeenAt: new Date().toISOString(), capabilities: [{ agentKey: 'synthetic', displayName: '合成 Agent', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: selection.modelId, displayName: '合成模型', source: 'configured' }] }] })
        await tx.resources.saveWorkspace({ id: selection.workspaceId, projectId: project.id, name: '消息工作区', spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [{ workerId: selection.workerId, status: 'ready', failureReason: null, location: null }], deletedAt: null })
      })
      const create = async (target, title) => (await owner.api(`/projects/${project.id}/tasks/${target.id}/sessions`, 'POST', { ...selection, title, requestId: `s-${name}-${suffix}-${title}` })).session
      return { project, task, other, selection, session: await create(task, '主会话'), second: await create(task, '第二会话'), otherSession: await create(other, '其他任务会话') }
    }
    const f = await fixture('default-team', 'default'), secondTeam = await fixture(team2.id, 'second')
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    await context.addInitScript(() => {
      window.composerProbe = { mode: '', consumed: 0, settled: 0, storage: '', restored: false }
      const json = Response.prototype.json
      Response.prototype.json = async function (...args) {
        const body = await json.apply(this, args)
        if (!/\/api\/sessions\/[^/]+\/messages$/.test(new URL(this.url).pathname)) return body
        const state = window.composerProbe; state.consumed++
        const mode = state.mode; state.mode = ''
        if (mode === 'hold') {
          state.heldResponse = { status: this.status, path: new URL(this.url).pathname, commandId: body.commandId, messageId: body.messageId, consumed: state.consumed }
          await new Promise(resolve => { window.releaseComposer = resolve })
        }
        state.settled++
        if (mode === 'lose') throw Error('Synthetic response lost after actual body consumption')
        return body
      }
      const get = Storage.prototype.getItem, set = Storage.prototype.setItem
      Storage.prototype.getItem = function (key) {
        if (key.startsWith('wemux.conversation-submission:') && window.composerProbe.storage === 'deny-read') throw Error('Synthetic read denied')
        return get.call(this, key)
      }
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('wemux.conversation-submission:') && (window.composerProbe.storage === 'deny-write' || (window.composerProbe.storage === 'deny-settlement' && JSON.parse(value).intent?.receipt))) throw Error('Synthetic write denied')
        return set.call(this, key, value)
      }
    })
    assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: email, password } })).status(), 200)
    const page = await context.newPage(); lastPage = page; page.setDefaultTimeout(12000)
    page.on('pageerror', error => errors.push({ name, error: error.message }))
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (/\/api\/sessions\/[^/]+\/messages$/.test(path) && request.method() === 'POST') posts.push({ name, path, body: request.postDataJSON() })
      if (/\/api\/commands\//.test(path)) receiptReads.push(path)
    })
    const path = (fixture = f, task = fixture.task, session = fixture.session) => `/next/projects/${fixture.project.id}?task=${task.id}&session=${session.id}`
    const spa = async target => page.evaluate(target => { history.pushState({}, '', target); dispatchEvent(new Event('wemux:navigate')) }, target)
    const panel = page.getByRole('region', { name: '任务会话对话', exact: true }), composer = panel.getByRole('region', { name: '消息提交', exact: true })
    const draft = composer.getByRole('textbox', { name: '新消息草稿', exact: true }), send = composer.getByRole('button', { name: '发送新消息', exact: true }), retry = composer.getByRole('button', { name: '重试原消息', exact: true })
    const ready = async () => { await panel.getByText('已读取会话', { exact: true }).waitFor(); await draft.waitFor() }
    const settlementFrames = async () => {
      await page.waitForFunction(() => window.composerProbe.consumed === window.composerProbe.settled)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve() }; channel.port2.postMessage(null)
      }))))
    }
    const durable = async sessionId => page.evaluate(sessionId => Object.entries(sessionStorage).filter(([key]) => key.startsWith('wemux.conversation-submission:')).map(([key, value]) => ({ key, value: JSON.parse(value) })).find(value => JSON.parse(value.key.split('wemux.conversation-submission:')[1])[5] === sessionId), sessionId)
    const enqueues = async () => {
      const summaries = await app.store.commands.list({ workerId: f.selection.workerId, limit: 1000 })
      assert.ok(summaries.length < 1000, 'fixture enumeration must not truncate')
      const details = await Promise.all(summaries.map(summary => app.store.commands.getPendingCommand(summary.commandId)))
      return details.filter(value => value?.command.kind === 'session.enqueue' && value.command.sessionId === f.session.id)
    }
    const countCommands = async () => (await enqueues()).length
    const refresh = async () => { const response = page.waitForResponse(response => new URL(response.url()).pathname === `/api/sessions/${f.session.id}`); await panel.getByRole('button', { name: '刷新会话历史', exact: true }).click(); await response; await ready() }
    step = `${name}: draft reload/no automatic send`
    await page.goto(origin + path()); await ready(); await draft.fill('  原始正文\n保持空格  ')
    assert.equal((await durable(f.session.id)).value.draft.content, '  原始正文\n保持空格  ')
    const startPosts = posts.length
    await page.reload(); await ready(); assert.equal(await draft.inputValue(), '  原始正文\n保持空格  ')
    check(posts.length === startPosts, `${name}: persisted draft reload does not send`)
    step = `${name}: refresh during pointer gesture`
    // A readiness check before pointerdown cannot guarantee readiness at pointerup.
    // Hold actual metadata application to pin the same boundary seen with Worker SSE.
    await page.evaluate(pathname => {
      const json = Response.prototype.json
      window.metadataConsumed = false
      Response.prototype.json = async function (...args) {
        const body = await json.apply(this, args)
        if (new URL(this.url).pathname !== pathname) return body
        Response.prototype.json = json; window.metadataConsumed = true
        await new Promise(resolve => { window.releaseMetadata = resolve }); return body
      }
    }, `/api/sessions/${f.session.id}`)
    await send.scrollIntoViewIfNeeded()
    const bounds = await send.boundingBox(); assert.ok(bounds)
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    // Trigger a real controller refresh while the pointer gesture is still open.
    await panel.getByRole('button', { name: '刷新会话历史', exact: true }).evaluate(button => button.click())
    await page.waitForFunction(() => window.metadataConsumed)
    assert.ok(await send.isDisabled())
    await page.mouse.up()
    assert.equal(posts.length, startPosts)
    assert.equal((await durable(f.session.id)).value.intent, null)
    // Exercise the submit-handler boundary independently of the disabled native
    // button: an already-dispatched submit must report a changed authority gate.
    await composer.locator('form').evaluate(form => form.requestSubmit())
    await composer.getByText('本次未发送：会话元数据尚未就绪或需要刷新，暂不能发送或重试。请在恢复后手动操作，不会自动重发。', { exact: true }).waitFor()
    assert.equal(posts.length, startPosts)
    assert.equal((await durable(f.session.id)).value.intent, null)
    await page.evaluate(() => window.releaseMetadata()); await ready()
    assert.equal((await durable(f.session.id)).value.draft.content, '  原始正文\n保持空格  ')
    assert.equal(posts.length, startPosts)
    assert.equal(await send.isDisabled(), false)
    await composer.getByText('本次未发送：', { exact: false }).waitFor()
    check(true, `${name}: refresh blocks pointer/submit admission with explicit not-sent feedback, preserves draft, and never auto-sends on recovery`)
    step = `${name}: lost response and original retry`
    const beforeCommands = await countCommands()
    await page.evaluate(() => { window.composerProbe.mode = 'lose' }); await send.click()
    await composer.getByText('原消息可能已接收，结果尚未确认。', { exact: false }).waitFor()
    const original = posts.at(-1)
    assert.equal(await composer.getByText('本次未发送：', { exact: false }).count(), 0)
    assert.equal(await page.evaluate(() => window.composerProbe.settled), 1)
    await draft.fill('新的独立草稿，不替换原请求')
    check(await send.isDisabled(), `${name}: unresolved original blocks new send, new draft editable`)
    await page.reload(); await ready(); await retry.waitFor()
    assert.equal(posts.length, startPosts + 1); assert.equal(await draft.inputValue(), '新的独立草稿，不替换原请求')
    // Both write affordances use current metadata, including the unresolved original.
    await owner.api(`/sessions/${f.session.id}`, 'PATCH', { archived: true }); await refresh()
    await composer.getByText('会话已删除或归档，不能发送或重试。').waitFor()
    assert.ok(await retry.isDisabled()); assert.ok(await send.isDisabled())
    await owner.api(`/sessions/${f.session.id}`, 'PATCH', { archived: false })
    await app.store.transaction(async tx => { const worker = await tx.resources.getWorker(f.selection.workerId); await tx.resources.saveWorker({ ...worker, capabilities: worker.capabilities.map(agent => ({ ...agent, availability: { status: 'unavailable' } })) }) })
    await refresh(); await composer.getByText('当前不允许发送：', { exact: false }).waitFor(); assert.ok(await retry.isDisabled()); assert.ok(await send.isDisabled())
    await app.store.transaction(async tx => { const worker = await tx.resources.getWorker(f.selection.workerId); await tx.resources.saveWorker({ ...worker, capabilities: worker.capabilities.map(agent => ({ ...agent, availability: { status: 'available' } })) }) }); await refresh()
    // Hold real metadata before controller application: neither new send nor retry may use stale facts.
    await page.evaluate(pathname => {
      const json = Response.prototype.json
      window.metadataConsumed = false
      Response.prototype.json = async function (...args) {
        const body = await json.apply(this, args)
        if (new URL(this.url).pathname !== pathname) return body
        Response.prototype.json = json; window.metadataConsumed = true
        await new Promise(resolve => { window.releaseMetadata = resolve }); return body
      }
    }, `/api/sessions/${f.session.id}`)
    await panel.getByRole('button', { name: '刷新会话历史', exact: true }).click(); await page.waitForFunction(() => window.metadataConsumed)
    assert.ok(await retry.isDisabled()); assert.ok(await send.isDisabled())
    await page.evaluate(() => window.releaseMetadata()); await ready()
    assert.equal(await retry.isDisabled(), false)
    check(posts.length === startPosts + 1, `${name}: unresolved retry and new send both blocked by archive/denied/stale metadata with zero POST`)
    // Duplicate real form submission while the first response is held shares one original identity.
    await page.evaluate(() => { window.composerProbe.mode = 'hold' })
    await retry.click(); await page.waitForFunction(() => window.composerProbe.consumed === 1)
    await composer.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
    assert.equal(posts.length, startPosts + 2)
    await page.evaluate(() => window.releaseComposer())
    await composer.getByText('消息接收回执：', { exact: false }).waitFor()
    assert.deepEqual(posts.at(-1).body, original.body); assert.equal(await countCommands(), beforeCommands + 1)
    const unique = await enqueues(); assert.equal(unique.length, 1); assert.equal(unique[0].commandId, original.body.commandId); assert.equal(unique[0].command.message.messageId, original.body.messageId); assert.equal(unique[0].command.message.content, original.body.content)
    await writeFile(join(evidence, `${name}-original-command.json`), JSON.stringify({ commands: unique.map(value => ({ commandId: value.commandId, sessionId: value.command.sessionId, message: value.command.message })), firstPost: original, retryPost: posts.at(-1) }, null, 2))
    assert.equal(await draft.inputValue(), '新的独立草稿，不替换原请求')
    check(true, `${name}: consumed lost response explicit retry uses identical body/IDs and one command; newer draft preserved`)
    check((await app.store.commands.get(original.body.commandId)).status === 'pending', `${name}: receipt is pending command admission, not Turn success`)
    step = `${name}: duplicate new send and held settlement`
    const duplicatePosts = posts.length
    await page.evaluate(() => { window.composerProbe.mode = 'hold' })
    await composer.locator('form').evaluate(form => { form.requestSubmit(); form.requestSubmit() })
    await page.waitForFunction(() => window.composerProbe.consumed === 2)
    await draft.fill('飞行期间的新草稿')
    await page.evaluate(() => window.releaseComposer()); await page.waitForFunction(() => window.composerProbe.settled === 2)
    await composer.getByText('最近消息接收记录', { exact: true }).waitFor()
    check(posts.length === duplicatePosts + 1 && await draft.inputValue() === '飞行期间的新草稿', `${name}: duplicate submit one POST and late settlement preserves newer draft`)
    step = `${name}: memory admission and actionable storage errors`
    await page.evaluate(() => { window.composerProbe.storage = 'deny-settlement' }); await send.click()
    await composer.getByText('已收到消息接收回执，但无法保存确认状态；', { exact: false }).waitFor()
    assert.equal((await durable(f.session.id)).value.intent.receipt, null); assert.ok(await send.isDisabled())
    await page.evaluate(() => { window.composerProbe.storage = 'deny-write' }); await draft.fill('未保存输入不会静默消失')
    await composer.getByText('无法确认会话内容已保存；', { exact: false }).waitFor()
    check(await composer.getByText('消息接收回执：', { exact: false }).count() === 1 && await send.isDisabled(), `${name}: memory-only receipt keeps actionable storage error and cannot authorize new send`)
    await page.evaluate(() => { window.composerProbe.storage = '' }); await composer.getByRole('button', { name: '保存当前输入', exact: true }).click(); await retry.click()
    await composer.getByText('最近消息接收记录', { exact: true }).waitFor(); assert.equal(await draft.inputValue(), '未保存输入不会静默消失')
    step = `${name}: denied and corrupt storage`
    await page.evaluate(() => { window.composerProbe.storage = 'deny-read' }); await composer.getByRole('button', { name: '重新读取会话存储' }).click()
    await composer.getByText('无法读取或验证会话存储；', { exact: false }).waitFor(); assert.ok(await send.isDisabled())
    await page.evaluate(() => { window.composerProbe.storage = '' }); await composer.getByRole('button', { name: '重新读取会话存储' }).click()
    const saved = await durable(f.session.id), storagePosts = posts.length
    await page.evaluate(key => sessionStorage.setItem(key, '{corrupt'), saved.key); await composer.getByRole('button', { name: '重新读取会话存储' }).click()
    await composer.getByText('无法读取或验证会话存储；', { exact: false }).waitFor(); assert.ok(await send.isDisabled()); assert.equal(posts.length, storagePosts)
    await page.evaluate(saved => sessionStorage.setItem(saved.key, JSON.stringify(saved.value)), saved); await composer.getByRole('button', { name: '重新读取会话存储' }).click()
    check(true, `${name}: denied/corrupt storage disables submission without clearing record; explicit restore recovers`)
    step = `${name}: archive and capability gates including offline`
    await owner.api(`/sessions/${f.session.id}`, 'PATCH', { archived: true }); await refresh()
    await composer.getByText('会话已删除或归档，不能发送或重试。').waitFor(); assert.ok(await send.isDisabled())
    await owner.api(`/sessions/${f.session.id}`, 'PATCH', { archived: false })
    await app.store.transaction(async tx => { const worker = await tx.resources.getWorker(f.selection.workerId); await tx.resources.saveWorker({ ...worker, connectionState: 'offline' }); await tx.cache.markWorkerOffline(worker.id) })
    await refresh(); await draft.fill('离线明确允许的持久投递'); assert.equal(await send.isDisabled(), false); await send.click(); await composer.getByText('最近消息接收记录', { exact: true }).waitFor()
    check(true, `${name}: offline Journal plus allowed send capability accepts durable enqueue`)
    await app.store.transaction(async tx => { const worker = await tx.resources.getWorker(f.selection.workerId); await tx.resources.saveWorker({ ...worker, capabilities: worker.capabilities.map(agent => ({ ...agent, availability: { status: 'unavailable' } })) }) })
    await refresh(); await composer.getByText('当前不允许发送：', { exact: false }).waitFor(); assert.ok(await send.isDisabled())
    check(true, `${name}: offline plus denied capability blocks send`)
    await app.store.transaction(async tx => { const worker = await tx.resources.getWorker(f.selection.workerId); await tx.resources.saveWorker({ ...worker, connectionState: 'online', capabilities: worker.capabilities.map(agent => ({ ...agent, availability: { status: 'available' } })) }) }); await refresh()
    step = `${name}: held late response across Session change, then Task draft isolation`
    await draft.fill('切换前持久原消息'); await page.evaluate(() => { window.composerProbe.mode = 'hold' }); await send.click()
    await page.waitForFunction(() => typeof window.releaseComposer === 'function' && window.composerProbe.consumed > window.composerProbe.settled)
    const held = await durable(f.session.id)
    await page.getByRole('button', { name: '查看会话：第二会话', exact: true }).click(); await ready(); assert.equal(await draft.inputValue(), '')
    await draft.fill('第二会话独立草稿')
    await page.evaluate(() => {
      window.releaseComposer()
      requestAnimationFrame(() => requestAnimationFrame(() => { const channel = new MessageChannel(); channel.port1.onmessage = () => { window.composerProbe.frames = true; channel.port1.close(); channel.port2.close() }; channel.port2.postMessage(null) }))
    }); await page.waitForFunction(() => window.composerProbe.frames && window.composerProbe.consumed === window.composerProbe.settled)
    assert.equal(await draft.inputValue(), '第二会话独立草稿'); assert.equal((await durable(f.session.id)).value.intent.receipt, null); assert.equal(await composer.getByRole('region', { name: '原消息请求' }).count(), 0)
    await page.getByRole('button', { name: f.other.title, exact: true }).click(); await page.getByRole('button', { name: '查看会话：其他任务会话', exact: true }).click(); await ready(); assert.equal(await draft.inputValue(), '')
    await spa(path()); await ready(); assert.equal((await durable(f.session.id)).value.intent.body.commandId, held.value.intent.body.commandId)
    check(true, `${name}: Session change suppresses held settlement; subsequent Task switch independently isolates draft`)
    await retry.click(); await composer.getByText('最近消息接收记录', { exact: true }).waitFor()
    step = `${name}: independent held late response across Task change`
    const taskSourceText = `任务切换前独立原消息 ${name}`, taskDestinationText = `目标任务独立草稿 ${name}`
    await draft.fill(taskSourceText)
    const taskProbeBefore = await page.evaluate(() => ({ consumed: window.composerProbe.consumed, settled: window.composerProbe.settled }))
    assert.equal(taskProbeBefore.consumed, taskProbeBefore.settled)
    const taskPostsBefore = posts.length
    await page.evaluate(() => { window.composerProbe.mode = 'hold' }); await send.click()
    await page.waitForFunction(before => window.composerProbe.consumed === before.consumed + 1 && window.composerProbe.settled === before.settled, taskProbeBefore)
    const taskHeld = await durable(f.session.id)
    assert.equal(taskHeld.value.intent.receipt, null)
    assert.equal(taskHeld.value.intent.body.content, taskSourceText)
    assert.equal(posts.length, taskPostsBefore + 1)
    const taskResponse = await page.evaluate(() => window.composerProbe.heldResponse)
    assert.equal(taskResponse.status, 202)
    assert.equal(taskResponse.path, `/api/sessions/${f.session.id}/messages`)
    assert.equal(taskResponse.commandId, taskHeld.value.intent.body.commandId)
    assert.equal(taskResponse.messageId, taskHeld.value.intent.body.messageId)
    // This Task replacement occurs while the successful original response is still unresolved.
    await page.getByRole('button', { name: f.other.title, exact: true }).click()
    assert.equal(new URL(page.url()).searchParams.get('task'), f.other.id)
    assert.equal(new URL(page.url()).searchParams.has('session'), false)
    await page.getByRole('button', { name: '查看会话：其他任务会话', exact: true }).click(); await ready()
    assert.equal(new URL(page.url()).searchParams.get('task'), f.other.id)
    assert.equal(new URL(page.url()).searchParams.get('session'), f.otherSession.id)
    assert.equal(await panel.getAttribute('data-conversation-session'), f.otherSession.id)
    assert.equal(await draft.inputValue(), '')
    await draft.fill(taskDestinationText)
    const taskDestinationBefore = await durable(f.otherSession.id), taskUIBefore = await composer.innerText()
    assert.equal(taskDestinationBefore.value.draft.content, taskDestinationText)
    assert.equal(taskDestinationBefore.value.intent, null)
    assert.equal(await composer.getByRole('region', { name: '原消息请求' }).count(), 0)
    assert.equal(await composer.getByRole('alert').count(), 0)
    const taskBeforeRelease = await page.evaluate(() => ({ consumed: window.composerProbe.consumed, settled: window.composerProbe.settled }))
    assert.equal(taskBeforeRelease.consumed, taskProbeBefore.consumed + 1)
    assert.equal(taskBeforeRelease.settled, taskProbeBefore.settled)
    // Observe rendered destination changes as well as final state after actual settlement and UI work.
    await composer.evaluate((element, original) => {
      window.taskLateLeaks = []
      window.taskLateObserver = new MutationObserver(() => {
        if (element.textContent.includes(original.content) || element.textContent.includes(original.commandId) || element.textContent.includes(original.messageId)
          || element.querySelector('[role="alert"]') || element.textContent.includes('消息接收回执：')) window.taskLateLeaks.push('old-submission-state')
      })
      window.taskLateObserver.observe(element, { childList: true, subtree: true, characterData: true })
      window.releaseComposer()
    }, taskHeld.value.intent.body)
    await settlementFrames()
    const taskAfterRelease = await page.evaluate(() => {
      window.taskLateObserver.disconnect()
      return { consumed: window.composerProbe.consumed, settled: window.composerProbe.settled, leaks: window.taskLateLeaks }
    })
    assert.equal(taskAfterRelease.settled, taskProbeBefore.settled + 1)
    assert.deepEqual(taskAfterRelease.leaks, [])
    assert.equal(await draft.inputValue(), taskDestinationText)
    assert.equal(await composer.innerText(), taskUIBefore)
    assert.deepEqual(await durable(f.otherSession.id), taskDestinationBefore)
    assert.deepEqual(await durable(f.session.id), taskHeld)
    assert.equal(await composer.getByRole('region', { name: '原消息请求' }).count(), 0)
    assert.equal(await composer.getByText('消息接收回执：', { exact: false }).count(), 0)
    assert.equal(await composer.getByRole('alert').count(), 0)
    assert.equal(posts.length, taskPostsBefore + 1)
    check(true, `${name}: independent Task change before held successful response release preserves destination draft/state without original receipt/error`)
    await writeFile(join(evidence, `${name}-task-late-response.json`), JSON.stringify({ source: { taskId: f.task.id, sessionId: f.session.id, commandId: taskHeld.value.intent.body.commandId, messageId: taskHeld.value.intent.body.messageId }, destination: { taskId: f.other.id, sessionId: f.otherSession.id, draft: taskDestinationText }, successfulResponse: taskResponse, beforeSend: taskProbeBefore, destinationReadyBeforeRelease: taskBeforeRelease, afterRelease: taskAfterRelease, destinationUIAndStorageUnchanged: true, originalDurableReceiptStillUnresolved: true, extraPosts: 0 }, null, 2))
    await composer.screenshot({ path: join(evidence, `${name}-task-late-response.png`) })
    await spa(path()); await ready(); await retry.waitFor()
    await retry.click(); await composer.getByText('最近消息接收记录', { exact: true }).waitFor()
    step = `${name}: team lifetime and held response`
    await draft.fill('团队切换原消息'); await page.evaluate(() => { window.composerProbe.mode = 'hold' }); await send.click(); await page.waitForFunction(() => window.composerProbe.consumed > window.composerProbe.settled)
    const teamPending = await durable(f.session.id)
    await spa('/next/teams'); await page.getByRole('heading', { name: '团队与成员', exact: true }).waitFor()
    await writeFile(join(evidence, `${name}-team-accessibility.txt`), await page.locator('main').ariaSnapshot())
    const teamSelect = page.getByRole('combobox', { name: '查看团队', exact: true }); assert.equal(await teamSelect.count(), 1); assert.ok(await teamSelect.isVisible()); assert.ok(await teamSelect.isEnabled()); await teamSelect.selectOption(team2.id); await page.getByRole('button', { name: '将此团队设为当前项目范围', exact: true }).click()
    // The owned team project must be visible before opening its Task: proves application client retirement.
    await spa('/next/projects'); await page.getByRole('link', { name: new RegExp(secondTeam.project.name) }).waitFor(); await spa(path(secondTeam)); await ready(); assert.equal(await draft.inputValue(), '')
    await draft.fill('另一团队草稿'); await page.evaluate(() => window.releaseComposer()); await settlementFrames()
    assert.equal(await draft.inputValue(), '另一团队草稿'); assert.equal((await durable(f.session.id)).value.intent.receipt, null)
    await spa('/next/teams'); await page.getByRole('combobox', { name: '查看团队', exact: true }).selectOption('default-team'); await page.getByRole('button', { name: '将此团队设为当前项目范围', exact: true }).click(); await spa('/next/projects'); await page.getByRole('link', { name: new RegExp(f.project.name) }).waitFor(); await spa(path()); await ready()
    assert.equal((await durable(f.session.id)).value.intent.body.commandId, teamPending.value.intent.body.commandId)
    check(true, `${name}: team client replacement isolates drafts and late submission settlement`)
    await retry.click(); await composer.getByText('最近消息接收记录', { exact: true }).waitFor()
    step = `${name}: account replacement/read-only`
    await draft.fill('账号切换前的私有草稿'); await page.evaluate(() => { window.composerProbe.mode = 'hold' }); await send.click(); await page.waitForFunction(() => window.composerProbe.consumed > window.composerProbe.settled)
    const accountPending = await durable(f.session.id)
    if (name === 'mobile') await page.getByRole('button', { name: '打开导航', exact: true }).click()
    await page.getByRole('button', { name: '退出登录', exact: true }).click(); await page.getByRole('heading', { name: '登录控制台', exact: true }).waitFor()
    await page.getByLabel('邮箱或用户名', { exact: true }).fill(viewerEmail); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click(); await ready()
    assert.equal(await draft.inputValue(), ''); await composer.getByText('当前会话为只读权限，不能发送或重试。').waitFor(); assert.ok(await send.isDisabled())
    await page.evaluate(() => window.releaseComposer()); await settlementFrames()
    assert.equal(await draft.inputValue(), ''); assert.equal(await composer.getByRole('region', { name: '原消息请求' }).count(), 0)
    const retainedOwner = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), accountPending.key); assert.equal(retainedOwner.intent.receipt, null)
    check(true, `${name}: same-tab account replacement hides prior draft/intent and held receipt; actual viewer cannot send`)
    await composer.screenshot({ path: join(evidence, `${name}-readonly.png`) })
    // Capture the unresolved owner state by real login, no automatic retry on adopt.
    if (name === 'mobile') await page.getByRole('button', { name: '打开导航', exact: true }).click()
    await page.getByRole('button', { name: '退出登录', exact: true }).click(); await page.getByLabel('邮箱或用户名', { exact: true }).fill(email); await page.getByLabel('密码', { exact: true }).fill(password); const priorLoginPosts = posts.length; await page.getByRole('button', { name: '登录', exact: true }).click(); await ready(); await retry.waitFor()
    assert.equal(posts.length, priorLoginPosts); assert.equal(await draft.inputValue(), '账号切换前的私有草稿')
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: composer has no horizontal overflow`)
    await composer.screenshot({ path: join(evidence, `${name}-pending.png`) })
    await writeFile(join(evidence, `${name}-scope-evidence.json`), JSON.stringify({ originalBody: original.body, heldBody: held.value.intent.body, teamBody: teamPending.value.intent.body, accountBody: accountPending.value.intent.body, noAutoResend: true, lateReceiptsUnsettled: true }, null, 2))
    await context.close()
  }
  assert.deepEqual(errors, []); assert.deepEqual(receiptReads, [])
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, checks, posts, errors, receiptReads, chromium: browser.version(), evidence: 'Actual Next/shared client/Server; synthetic Worker capability fixture, no Worker/Runtime execution. Visual acceptance unverified.' }, null, 2))
  console.log(`Next composer browser passed (${checks.length} checks): ${evidence}`)
} catch (error) {
  if (lastPage && !lastPage.isClosed()) { await writeFile(join(evidence, 'failure-dom.html'), await lastPage.content()); await writeFile(join(evidence, 'failure-accessibility.txt'), await lastPage.locator('body').ariaSnapshot()) }
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ step, checks, posts, errors, error: String(error.stack ?? error) }, null, 2)); console.error(`Composer browser failed at ${step}: ${evidence}`); throw error
} finally {
  await browser?.close(); await app.close()
  for (const file of ['server.sqlite', 'server.sqlite.transport']) for (const suffix of ['', '-wal', '-shm']) await rm(join(evidence, file + suffix), { force: true })
  await writeFile(join(evidence, 'cleanup.json'), JSON.stringify({ browserClosed: true, serverClosed: true, databaseRemoved: true }))
}
