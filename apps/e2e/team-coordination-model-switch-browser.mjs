#!/usr/bin/env node
/** Ticket 04: browser-level model switch on Team coordination Sessions.
 * Verifies: page open creates no Task; first send auto-creates the Team coordination Task and is
 * reused by later first sends; selecting another model takes effect on the NEXT Turn only.
 * WEMUX_NEXT_TEST_DIST=/tmp/... PLAYWRIGHT_CORE_PATH=... PLAYWRIGHT_CHROMIUM_PATH=...
 * TMPDIR must support SQLite WAL (on this host, use a disk directory rather than /tmp).
 * Deterministic Test Agent only; no paid Runtime, no production credentials, no persistent user data.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createWemuxServer } from '../server/src/server.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { login } from './session.ts'
import { ownedWorkerLaunch, removeOwnedServerDatabases } from './owned-worker-fixture.mjs'

assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'), 'use a disposable /tmp Web-next build copy')
assert.ok(process.env.PLAYWRIGHT_CORE_PATH && process.env.PLAYWRIGHT_CHROMIUM_PATH, 'explicit browser paths required')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH)
const dir = await mkdtemp(join(tmpdir(), 'wemux-model-switch-'))
const database = join(dir, 'server.sqlite'), home = join(dir, 'worker')
const email = 'model-switch-owner@example.test', password = 'model-switch-test-only-password'
const app = createWemuxServer({ databasePath: database, administratorEmails: [email], mail: {}, google: {}, webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST) })
let worker, browser, step = 'setup'
const contexts = [], checks = [], errors = []
const eventually = async (read, accept, label) => {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const value = await read()
    if (accept(value)) return value
    await delay(100)
  }
  throw Error(`Timed out: ${label}`)
}
function launch(args, origin) {
  const isolated = ownedWorkerLaunch(args, origin)
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...isolated.args], { cwd: process.cwd(), env: isolated.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })) })
  void done.catch(() => {})
  return { child, done }
}
const turnStartedModels = api => async sessionId => {
  const value = await api(`/sessions/${sessionId}/events?fromSeq=1&limit=1000`)
  return value.events.filter(event => event.payload.kind === 'turn.started').map(event => event.payload.modelId)
}
try {
  const origin = await app.listen(0)
  await seedLocalAccount(app.store, { username: email, email, password, administrator: true })
  const owner = await login(origin, email, password), api = owner.api
  await api('/bootstrap', 'POST', {})
  const token = await api('/enrollment-tokens', 'POST', {})
  const registration = await launch(['register', '--home', home, `--token=${token.token}`, '--name', 'Model Switch Worker'], origin).done
  assert.equal(registration.code, 0, 'owned Worker enrollment')
  const workerId = JSON.parse(registration.stdout).workerId
  worker = launch(['start', '--home', home, '--name', 'Model Switch Worker'], origin)
  await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities.some(item => item.agentKey === 'test' && item.models.some(model => model.modelId === 'test-alt')), 'Test Agent with second advertised model')
  const project = await api('/projects', 'POST', { name: 'Model switch placement', teamId: 'default-team', requestId: randomUUID() })
  const placed = await api('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Model switch Workspace', source: 'empty', requestId: randomUUID() })
  await eventually(() => api(`/workspaces/${placed.workspace.id}`), value => value.placements.some(item => item.workerId === workerId && item.status === 'ready'), 'ready Workspace')
  const coordinationTaskIds = new Set()
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  for (const [name, viewport, firstIndex, firstModel, nextModel] of [['desktop', { width: 1440, height: 1000 }, 1, 'test', 'test-alt'], ['mobile', { width: 390, height: 844 }, 2, 'test-alt', 'test']]) {
    step = `${name} page open without Task`
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    contexts.push(context)
    assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: email, password } })).status(), 200, 'browser login')
    const page = await context.newPage()
    page.setDefaultTimeout(30000)
    page.on('pageerror', () => errors.push({ viewport: name }))
    const before = await context.request.get(`${origin}/api/teams/default-team/coordination/sessions`)
    assert.equal((await before.json()).items.length, coordinationTaskIds.size, 'known Session count before opening page')
    await page.goto(`${origin}/next/teams`)
    const select = page.getByRole('combobox', { name: '协调执行环境' })
    await select.waitFor()
    await eventually(() => select.locator('option').count(), count => count > 1, 'authorized ready placement options')
    const afterOpen = await context.request.get(`${origin}/api/teams/default-team/coordination/sessions`)
    assert.equal((await afterOpen.json()).items.length, coordinationTaskIds.size, 'opening the page must not create a Task or Session')
    checks.push(`${name}: page open loads choices without creating a Task`)
    step = `${name} first send with base model`
    const optionText = await select.locator('option').nth(firstIndex).textContent()
    assert.match(optionText, new RegExp(`（${firstModel}）$`), 'chosen environment option advertises the expected model')
    await select.selectOption({ index: firstIndex })
    const text = `model-switch-${name}-first`
    await page.getByRole('textbox', { name: '协调首条消息' }).fill(text)
    await page.getByRole('button', { name: '发送并创建会话' }).click()
    const conversation = page.getByRole('region', { name: '任务会话对话' })
    await conversation.waitFor()
    await conversation.getByText(text).last().waitFor()
    await conversation.getByText(/Turn 已完成/).waitFor()
    const sessionId = await conversation.getAttribute('data-conversation-session')
    assert.ok(sessionId)
    const list = await (await context.request.get(`${origin}/api/teams/default-team/coordination/sessions`)).json()
    const mine = list.items.find(item => item.id === sessionId)
    assert.ok(mine?.taskId?.startsWith('coordination:'), 'first send binds the Session to a Team coordination Task')
    coordinationTaskIds.add(mine.taskId)
    assert.equal(coordinationTaskIds.size, 1, 'desktop and mobile first sends reuse the same Team coordination Task')
    const started = await turnStartedModels(api)(sessionId)
    assert.deepEqual(started, [firstModel], 'first Turn is bound to the initially selected model')
    checks.push(`${name}: first send creates the coordination Task (reused across viewports) and completes on model ${firstModel}`)
    step = `${name} model switch applies to next Turn only`
    const modelSelect = conversation.getByLabel('选择后续模型')
    await eventually(async () => (await modelSelect.locator('option').count()), count => count >= 2, 'second model offered in browser')
    await modelSelect.selectOption(nextModel)
    await conversation.getByRole('button', { name: '应用到后续 Turn' }).click()
    await eventually(async () => (await turnStartedModels(api)(sessionId)).length, async count => count >= 1 && (await api(`/sessions/${sessionId}/events?fromSeq=1&limit=1000`)).events.some(event => event.payload.kind === 'model.changed' && event.payload.previousModelId === firstModel && event.payload.modelId === nextModel), 'model.changed journaled')
    await conversation.getByText(`模型历史：${firstModel} → ${nextModel}，不追溯改变已有 Turn`).waitFor()
    await conversation.getByRole('button', { name: '刷新会话历史' }).click()
    await eventually(async () => conversation.getByText(`已确认选择：${nextModel}`).count(), count => count > 0, 'confirmed selection shows the new model')
    const followUp = `model-switch-${name}-after`
    await conversation.getByRole('textbox', { name: '新消息草稿' }).fill(followUp)
    await conversation.getByRole('button', { name: '发送新消息' }).click()
    await eventually(async () => conversation.getByText(followUp).count(), count => count > 0, 'follow-up message visible')
    await conversation.getByText(followUp).last().waitFor()
    await eventually(async () => {
      const value = await api(`/sessions/${sessionId}/events?fromSeq=1&limit=1000`)
      return value.events.filter(event => event.payload.kind === 'turn.finished' && event.payload.outcome === 'completed').length >= 2
    }, ok => ok, 'follow-up Turn completed')
    const models = await turnStartedModels(api)(sessionId)
    assert.equal(models[0], firstModel, 'already-started Turn keeps its fixed model')
    assert.equal(models.at(-1), nextModel, 'the next Turn runs on the switched model')
    checks.push(`${name}: browser model switch to ${nextModel} takes effect on the next Turn only`)
  }
  assert.deepEqual(errors, [], 'browser page errors')
  console.log(JSON.stringify({ status: 'pass', checks }))
} catch (error) {
  // Never print login, registration token or Worker stdout/stderr.
  console.error(JSON.stringify({ status: 'fail', step, errorName: error?.name ?? 'Error', message: String(error?.message ?? ''), checks, pageErrorCount: errors.length }))
  process.exitCode = 1
} finally {
  for (const context of contexts) await context.close().catch(() => {})
  await browser?.close().catch(() => {})
  if (worker) {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGTERM')
    const timer = setTimeout(() => worker.child.kill('SIGKILL'), 10000)
    try { const stopped = await worker.done; assert.equal(stopped.code, 0, 'owned Worker graceful stop') }
    catch { process.exitCode = 1 }
    finally { clearTimeout(timer) }
  }
  await app.close().catch(() => { process.exitCode = 1 })
  await removeOwnedServerDatabases(database).catch(() => { process.exitCode = 1 })
  await rm(dir, { recursive: true, force: true }).catch(() => { process.exitCode = 1 })
}
