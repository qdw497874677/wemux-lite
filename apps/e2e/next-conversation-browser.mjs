/** Read-only Next + actual Server HTTP/SSE/client/controller. Synthetic journal ingress, no Worker/Runtime.
 * Build Vite into owned /tmp; WEMUX_NEXT_TEST_DIST=/tmp/... node --import tsx apps/e2e/next-conversation-browser.mjs
 * Explicit installed PLAYWRIGHT_CORE_PATH and PLAYWRIGHT_CHROMIUM_PATH required; never installs tooling.
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createWemuxServer } from '../server/src/server.ts'
import { provisionAdministrator } from './session.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { launchAcceptanceBrowser } from '../web-next/tests/acceptance-runtime.mjs'

assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'), 'owned temporary build required')
const evidence = await mkdtemp(join(tmpdir(), 'wemux-next-conversation-browser-'))
const email = 'conversation-owner@example.test', password = 'synthetic-conversation-password'
const app = createWemuxServer({ databasePath: join(evidence, 'server.sqlite'), administratorEmails: [email], mail: {}, google: {}, webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST) })
const origin = await app.listen(0), checks = [], errors = [], streams = [], reads = [], mutations = []
const streamResponses = new Set()
const reconnectWaiters = new Set()
// Negative control changes only this owned browser's reconnect URL, never product source.
const reconnectNegativeControl = process.env.WEMUX_CONVERSATION_RECONNECT_NEGATIVE_CONTROL === '1'
app.server.on('request', (request, response) => {
  const url = new URL(request.url, origin)
  if (/\/sessions\/[^/]+\/(events|stream)$/.test(url.pathname)) reads.push({ path: url.pathname, fromSeq: url.searchParams.get('fromSeq') })
  if (/\/sessions\/[^/]+\/stream$/.test(url.pathname)) { const observed = { path: url.pathname, fromSeq: url.searchParams.get('fromSeq') }; streams.push(observed); for (const listener of reconnectWaiters) listener(observed); streamResponses.add(response); response.on('close', () => streamResponses.delete(response)) }
})
let browser, step = 'fixture'
const check = (ok, label) => { assert.ok(ok, label); checks.push(label) }
try {
  const owner = await provisionAdministrator({ store: app.store, baseUrl: origin, email, password })
  await owner.api('/bootstrap', 'POST', {})
  const viewerEmail = 'conversation-viewer@example.test'
  await seedLocalAccount(app.store, { username: viewerEmail, email: viewerEmail, password })
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: viewerEmail, password }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), viewerAuth = await login.json()
  const invitation = await owner.api('/teams/default-team/invitations', 'POST', { email: viewerEmail })
  assert.equal((await fetch(`${origin}/api/team-invitations/${invitation.token}/accept`, { method: 'POST', headers: { Cookie: cookie, 'x-csrf-token': viewerAuth.csrfToken, 'content-type': 'application/json' }, body: '{}' })).status, 200)
  browser = await launchAcceptanceBrowser()
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    step = `${name}: fixture`
    const project = await owner.api('/projects', 'POST', { name: `只读对话 ${name}`, teamId: 'default-team', requestId: `project-${name}` })
    await owner.api(`/projects/${project.id}/access`, 'PATCH', { shareScope: 'team' })
    const task = await owner.api(`/projects/${project.id}/tasks`, 'POST', { title: `历史阅读 ${name}`, requestId: `task-${name}` })
    const other = await owner.api(`/projects/${project.id}/tasks`, 'POST', { title: `另一任务 ${name}`, requestId: `other-${name}` })
    const selection = { workspaceId: `space-${name}`, workerId: `worker-${name}`, agentKey: 'synthetic', modelId: 'fixture/model' }
    await app.store.transaction(async tx => {
      await tx.resources.saveWorker({ id: selection.workerId, teamId: project.teamId, ownerId: project.ownerId, name: `合成节点 ${name}`, shareScope: 'team', connectionState: 'online', version: '1', platform: 'linux', lastSeenAt: new Date().toISOString(), capabilities: [{ agentKey: 'synthetic', displayName: '合成执行者', version: '1', mode: 'execution', availability: { status: 'available' }, models: [{ modelId: selection.modelId, displayName: '合成模型', source: 'configured' }] }] })
      await tx.resources.saveWorkspace({ id: selection.workspaceId, projectId: project.id, name: '会话工作区', spec: { kind: 'composite', memberWorkspaceIds: [] }, placements: [{ workerId: selection.workerId, status: 'ready', failureReason: null, location: null }], deletedAt: null })
    })
    const create = async (target, title, requestId) => (await owner.api(`/projects/${project.id}/tasks/${target.id}/sessions`, 'POST', { ...selection, title, requestId })).session
    const session = await create(task, `审阅会话 ${name}`, `session-${name}`), empty = await create(task, `空会话 ${name}`, `empty-${name}`), wrong = await create(other, `其他任务会话 ${name}`, `wrong-${name}`)
    const escaped = '<img src=x onerror="window.conversationPayloadExecuted=true"><script>window.conversationPayloadExecuted=true</script>'
    let seq = 0
    const ingress = async (payloads, notify = true) => {
      await app.store.transaction(async tx => {
        await tx.cache.applyEvents(session.id, payloads.map(payload => ({ sessionId: session.id, seq: ++seq, occurredAt: '2026-10-03T12:00:00.000Z', payload })))
        await tx.cache.recordWorkerHead(session.id, seq)
      })
      if (notify) app.service.notifications.session(session.id)
    }
    await ingress([
      { kind: 'message.queued', commandId: 'command-1', messageId: 'message-1', content: '请检查构建结果，不执行修改。', position: 0 },
      { kind: 'turn.started', turnId: 'turn-1', messageId: 'message-1' },
      { kind: 'assistant.text.delta', turnId: 'turn-1', text: '正在核对历史。' },
      { kind: 'assistant.text.delta', turnId: 'turn-1', streamKind: 'reasoning_text', text: '推理内容样例' },
      { kind: 'assistant.text.delta', turnId: 'turn-1', streamKind: 'plan_text', text: '计划内容样例' },
      { kind: 'tool.started', turnId: 'turn-1', toolCallId: 'tool-1', toolName: 'read', input: { path: 'README.md', untrusted: escaped } },
      { kind: 'tool.output.delta', turnId: 'turn-1', toolCallId: 'tool-1', text: escaped + '\n' + '超长输出'.repeat(2300) + '\n输出末尾可访问' },
      { kind: 'tool.finished', turnId: 'turn-1', toolCallId: 'tool-1', exitCode: 0 },
      { kind: 'usage.updated', turnId: 'turn-1', usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20, modelId: selection.modelId, completeness: 'partial' } },
      { kind: 'model.changed', previousModelId: null, modelId: selection.modelId },
      { kind: 'runtime.notice', level: 'warning', code: 'synthetic-notice', message: '这是合成历史，不是实际执行。' },
      { kind: 'turn.finished', turnId: 'turn-1', outcome: 'failed', failure: { code: 'agent-error', message: '合成失败记录' } },
      // 待决审批必须位于仍开启的 Turn：turn.finished 会将本轮审批置为 expired
      { kind: 'turn.started', turnId: 'turn-2', messageId: 'message-1' },
      { kind: 'approval.requested', turnId: 'turn-2', approvalId: 'approval-1', action: { command: 'synthetic-only' }, reason: '需要人工确认' },
    ])
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: email, password } })).status(), 200)
    const page = await context.newPage(); page.setDefaultTimeout(12000)
    page.on('pageerror', error => errors.push({ name, message: error.message }))
    page.on('request', request => { if (/\/api\/sessions\//.test(request.url()) && request.method() !== 'GET') mutations.push({ method: request.method(), path: new URL(request.url()).pathname }) })
    const path = (taskId = task.id, sessionId = '') => `${origin}/next/projects/${project.id}?keep=unchanged&task=${taskId}${sessionId ? `&session=${sessionId}` : ''}`
    const panel = page.getByRole('region', { name: '任务会话对话', exact: true })
    const history = panel.getByRole('region', { name: '会话历史', exact: true })
    const cursor = async number => { await history.getByText(`已应用连续游标：${number}；`, { exact: false }).waitFor() }
    step = `${name}: open keyboard/reload/back`
    await page.goto(path())
    const open = page.getByRole('button', { name: `查看会话：${session.title}`, exact: true })
    await open.focus(); await page.keyboard.press('Enter'); await cursor(seq)
    check(new URL(page.url()).searchParams.get('session') === session.id, `${name}: actual list keyboard open sets Session URL`)
    check(await panel.getByRole('heading', { name: '任务会话对话', exact: true }).evaluate(element => element === document.activeElement), `${name}: conversation heading receives focus`)
    await page.reload(); await cursor(seq)
    check(new URL(page.url()).searchParams.get('keep') === 'unchanged', `${name}: reload retains selected Session and unrelated search`)
    await page.getByRole('button', { name: `查看会话：${empty.title}`, exact: true }).click()
    await history.getByText('暂无已验证的会话历史。', { exact: true }).waitFor()
    await page.goBack(); await cursor(seq)
    check(new URL(page.url()).searchParams.get('session') === session.id, `${name}: back restores original Session`)
    step = `${name}: rendering and content accessibility`
    await panel.getByText('推理内容样例', { exact: true }).waitFor(); await panel.getByText('计划内容样例', { exact: true }).waitFor()
    await panel.getByText('尚未处理的审批：1。', { exact: true }).waitFor()
    const tool = panel.locator('.conversation-tool'), summary = tool.locator(':scope > summary')
    await summary.focus(); await page.keyboard.press('Enter')
    assert.equal(await tool.getAttribute('open'), '')
    await tool.locator('summary').filter({ hasText: '字段' }).click()
    while (await tool.getByRole('button', { name: /^显示更多内容/ }).count()) await tool.getByRole('button', { name: /^显示更多内容/ }).first().click()
    check((await tool.textContent()).includes('输出末尾可访问'), `${name}: all long tool output remains accessible incrementally`)
    check((await tool.textContent()).includes(escaped), `${name}: tool input/output rendered as escaped text`)
    check(await panel.locator('img, script, iframe').count() === 0 && !await page.evaluate(() => window.conversationPayloadExecuted), `${name}: payload never executes as HTML`)
    check(await panel.getByRole('button', { name: /^(发送|停止|批准|拒绝|切换模型)$/ }).count() === 0, `${name}: no falsely enabled mutation controls`)
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, panelWidth: document.querySelector('.session-conversation').getBoundingClientRect().width, focusableSummaries: document.querySelectorAll('.session-conversation summary').length }))
    check(geometry.documentWidth <= geometry.viewport && geometry.panelWidth <= geometry.viewport, `${name}: no horizontal overflow with expanded long tool`)
    await writeFile(join(evidence, `${name}-geometry.json`), JSON.stringify(geometry, null, 2))
    await panel.screenshot({ path: join(evidence, `${name}-expanded.png`) })
    await summary.click(); await panel.screenshot({ path: join(evidence, `${name}-conversation.png`) })
    step = `${name}: incremental HTTP/SSE and reconnect`
    const before = seq
    await ingress([{ kind: 'assistant.text.delta', turnId: 'turn-2', text: '增量回复唯一' }]); await cursor(seq)
    for (let i = 0; i < 3; i++) app.service.notifications.session(session.id)
    await panel.getByRole('button', { name: '刷新会话历史', exact: true }).click(); await cursor(seq)
    check(await history.getByText('增量回复唯一', { exact: true }).count() === 1, `${name}: invalidation/replay refresh has no duplicates`)
    // Hold an actually consumed history body before projection application. Serial controller drain
    // cannot advance while held; reconnect must independently request the exact current prefix + 1.
    await page.evaluate(({ pathname, streamPath, negative }) => {
      const original = Response.prototype.json
      window.reconnectHistory = { consumed: false, released: false }
      const gate = new Promise(resolve => { window.releaseReconnectHistory = resolve })
      Response.prototype.json = async function (...args) {
        const body = await original.apply(this, args)
        if (new URL(this.url).pathname !== pathname) return body
        Response.prototype.json = original
        window.reconnectHistory.consumed = true
        await gate
        window.reconnectHistory.released = true
        return body
      }
      if (negative) {
        const fetch = window.fetch
        window.fetch = (input, init) => {
          const url = new URL(typeof input === 'string' ? input : input.url ?? String(input), location.href)
          if (url.pathname === streamPath) { url.searchParams.set('fromSeq', '9999'); return fetch(url, init) }
          return fetch(input, init)
        }
      }
    }, { pathname: `/api/sessions/${session.id}/events`, streamPath: `/api/sessions/${session.id}/stream`, negative: reconnectNegativeControl })
    await panel.getByRole('button', { name: '刷新会话历史', exact: true }).click()
    await page.waitForFunction(() => window.reconnectHistory.consumed)
    await cursor(before + 1)
    const reconnect = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reconnectWaiters.delete(listener); reject(Error('Owned native reconnect request was not observed')) }, 12000)
      const listener = value => { if (value.path === `/api/sessions/${session.id}/stream`) { clearTimeout(timer); reconnectWaiters.delete(listener); resolve(value) } }
      reconnectWaiters.add(listener)
    })
    for (const response of streamResponses) response.destroy()
    await ingress([{ kind: 'runtime.notice', level: 'info', code: 'missed-1', message: '重连补传甲' }, { kind: 'runtime.notice', level: 'info', code: 'missed-2', message: '重连补传乙' }], false)
    const reconnected = await reconnect
    const barrier = await page.evaluate(() => window.reconnectHistory)
    await writeFile(join(evidence, `${name}-reconnect.json`), JSON.stringify({ barrier, expectedFromSeq: before + 2, observed: reconnected, negativeControl: reconnectNegativeControl, reads, streams }, null, 2))
    check(barrier.consumed && !barrier.released && reconnected.fromSeq === String(before + 2), `${name}: native stream reconnect uses contiguous cursor`)
    await page.evaluate(() => window.releaseReconnectHistory())
    await cursor(seq)
    check(await history.getByText('重连补传甲', { exact: true }).count() === 1 && await history.getByText('重连补传乙', { exact: true }).count() === 1, `${name}: reconnect HTTP catch-up recovers missed events once`)
    step = `${name}: offline/error/explicit retry`
    await app.store.transaction(tx => tx.cache.markWorkerOffline(selection.workerId)); app.service.notifications.session(session.id)
    await history.getByText('Worker 离线；', { exact: false }).waitFor()
    const eventsMatcher = url => url.pathname === `/api/sessions/${session.id}/events`
    const reject = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic unavailable' }) })
    await page.route(eventsMatcher, reject); await panel.getByRole('button', { name: '刷新会话历史', exact: true }).click()
    await panel.getByText('读取失败，保留上次已验证历史', { exact: false }).waitFor()
    check(await history.getByText('增量回复唯一', { exact: true }).count() === 1, `${name}: read error retains validated history and exposes needsRefresh`)
    await page.unroute(eventsMatcher, reject); await panel.getByRole('button', { name: '重新连接并重试', exact: true }).click(); await panel.getByText('已读取会话', { exact: false }).waitFor()
    step = `${name}: delayed old history after switching Session`
    await page.getByRole('button', { name: `查看会话：${empty.title}`, exact: true }).click(); await history.getByText('暂无已验证的会话历史。').waitFor()
    await page.evaluate(pathname => {
      const original = Response.prototype.json
      window.heldConversation = { consumed: false, released: false, frames: false, leaks: [] }
      const gate = new Promise(resolve => { window.releaseConversation = resolve })
      Response.prototype.json = async function (...args) {
        const body = await original.apply(this, args)
        if (new URL(this.url).pathname !== pathname) return body
        Response.prototype.json = original
        window.heldConversation.consumed = true
        await gate
        window.heldConversation.released = true
        return body
      }
    }, `/api/sessions/${session.id}/events`)
    await page.getByRole('button', { name: `查看会话：${session.title}`, exact: true }).click()
    await page.waitForFunction(() => window.heldConversation.consumed)
    await panel.getByText('正在加载会话', { exact: false }).waitFor()
    await page.getByRole('button', { name: `查看会话：${empty.title}`, exact: true }).click(); await history.getByText('暂无已验证的会话历史。').waitFor()
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        if (document.querySelector('.conversation-journal')?.textContent.includes('请检查构建结果')) window.heldConversation.leaks.push('old-history')
      })
      observer.observe(document.querySelector('.session-conversation'), { childList: true, subtree: true, characterData: true })
      window.releaseConversation()
      requestAnimationFrame(() => requestAnimationFrame(() => { const channel = new MessageChannel(); channel.port1.onmessage = () => { observer.disconnect(); window.heldConversation.frames = true; channel.port1.close(); channel.port2.close() }; channel.port2.postMessage(null) }))
    })
    await page.waitForFunction(() => window.heldConversation.frames)
    const delayed = await page.evaluate(() => window.heldConversation)
    check(delayed.released && !delayed.leaks.length && !await history.locator('[data-journal-seq]').count(), `${name}: consumed delayed old history cannot flash in new selection after release/frames`)
    await writeFile(join(evidence, `${name}-delayed.json`), JSON.stringify(delayed, null, 2))
    step = `${name}: task clearing and wrong binding`
    await page.getByRole('button', { name: other.title, exact: true }).click()
    check(!new URL(page.url()).searchParams.has('session') && new URL(page.url()).searchParams.get('keep') === 'unchanged' && !await panel.count(), `${name}: switching Task clears Session only`)
    await page.goto(path(task.id, wrong.id)); await panel.getByText('会话不可访问，已清除历史', { exact: false }).waitFor()
    check((await panel.textContent()).includes('scope-mismatch') && !await panel.getByRole('region', { name: '权威会话元数据' }).count(), `${name}: wrong Task/Session is blocked without fallback or metadata`)
    await page.goto(path(task.id, '%20%20')); await panel.getByText('会话标识无效，请关闭后从任务会话列表重新选择。', { exact: true }).waitFor()
    check(!await panel.locator('[data-journal-seq]').count(), `${name}: blank URL identity never constructs a controller or falls back`)
    await page.goto(path(task.id, 'missing-session')); await panel.getByText('会话不可访问，已清除历史', { exact: false }).waitFor()
    check(new URL(page.url()).searchParams.get('session') === 'missing-session', `${name}: missing Session does not fall back`)
    await panel.getByRole('button', { name: '关闭会话', exact: true }).click()
    check(!new URL(page.url()).searchParams.has('session') && new URL(page.url()).searchParams.get('task') === task.id, `${name}: close Session retains Task`)
    await page.getByRole('button', { name: `查看会话：${session.title}`, exact: true }).click(); await cursor(seq)
    await page.getByRole('button', { name: '关闭详情', exact: true }).click()
    check(!new URL(page.url()).searchParams.has('session') && !new URL(page.url()).searchParams.has('task') && new URL(page.url()).searchParams.get('keep') === 'unchanged', `${name}: close Task clears Task/Session and preserves unrelated search`)
    await context.close()
    step = `${name}: real server permission loss`
    const viewer = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    assert.equal((await viewer.request.post(`${origin}/api/auth/login`, { data: { login: viewerEmail, password } })).status(), 200)
    const viewerPage = await viewer.newPage(); viewerPage.setDefaultTimeout(12000)
    viewerPage.on('pageerror', error => errors.push({ name, message: error.message }))
    await viewerPage.goto(path(task.id, session.id))
    const viewerPanel = viewerPage.getByRole('region', { name: '任务会话对话', exact: true })
    await viewerPanel.getByText('增量回复唯一', { exact: true }).waitFor()
    await owner.api(`/sessions/${session.id}/access`, 'PATCH', { shareScope: 'owner-only' })
    await viewerPanel.getByRole('button', { name: '刷新会话历史', exact: true }).click()
    await viewerPanel.getByText('会话不可访问，已清除历史', { exact: false }).waitFor()
    check(!await viewerPanel.locator('[data-journal-seq]').count() && !await viewerPanel.getByRole('region', { name: '权威会话元数据' }).count(), `${name}: actual permission loss scrubs retained metadata/history`)
    await viewerPanel.getByRole('button', { name: '重新连接并重试', exact: true }).click()
    await viewerPanel.getByText('会话不可访问，已清除历史', { exact: false }).waitFor()
    await viewerPanel.screenshot({ path: join(evidence, `${name}-blocked.png`) })
    await owner.api(`/sessions/${session.id}/access`, 'PATCH', { shareScope: 'project' })
    await viewerPanel.getByRole('button', { name: '重新连接并重试', exact: true }).click()
    await viewerPanel.getByText('增量回复唯一', { exact: true }).waitFor()
    check(await viewerPanel.getByText('增量回复唯一', { exact: true }).count() === 1, `${name}: explicit blocked retry reauthorizes same Session after restored permission`)
    await viewer.close()
  }
  assert.deepEqual(errors, []); assert.deepEqual(mutations, [])
  check(reads.some(value => value.path.endsWith('/events')) && reads.some(value => value.path.endsWith('/stream')), 'actual public history and native SSE reads observed')
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, checks, errors, mutations, reads, streams, chromium: browser.version(), evidence: 'Synthetic journal/cache ingress; actual isolated Server authorization and browser HTTP/SSE/shared client/controller/projector. No actual Worker/Runtime or paid models.' }, null, 2))
  console.log(`Next conversation browser passed (${checks.length} checks): ${evidence}`)
} catch (error) {
  await writeFile(join(evidence, 'failure.json'), JSON.stringify({ step, checks, errors, reads, streams, reconnectNegativeControl, error: String(error.stack ?? error) }, null, 2)); console.error(`Conversation browser failed at ${step}: ${evidence}`); throw error
} finally {
  await browser?.close(); await app.close()
  for (const file of ['server.sqlite', 'server.sqlite.transport']) for (const suffix of ['', '-wal', '-shm']) await rm(join(evidence, `${file}${suffix}`), { force: true })
  await writeFile(join(evidence, 'cleanup.json'), JSON.stringify({ browserClosed: true, serverClosed: true, ownedDatabaseRemoved: true }))
}
