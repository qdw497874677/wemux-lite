#!/usr/bin/env node
/** Owned Server + enrolled Worker + Test Agent + actual /next/ desktop/mobile Chromium.
 * WEMUX_NEXT_TEST_DIST=/tmp/... PLAYWRIGHT_CORE_PATH=... PLAYWRIGHT_CHROMIUM_PATH=...
 * TMPDIR must support SQLite WAL (on this host, use a disk directory rather than /tmp).
 * No paid Runtime, production credentials, or persistent user data.
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
const dir = await mkdtemp(join(tmpdir(), 'wemux-team-browser-'))
const database = join(dir, 'server.sqlite'), home = join(dir, 'worker')
const email = 'team-browser-owner@example.test', password = 'team-browser-test-only-password'
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
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })) })
  void done.catch(() => {})
  return { child, done }
}
try {
  const origin = await app.listen(0)
  await seedLocalAccount(app.store, { username: email, email, password, administrator: true })
  const owner = await login(origin, email, password), api = owner.api
  await api('/bootstrap', 'POST', {})
  const token = await api('/enrollment-tokens', 'POST', {})
  const registration = await launch(['register', '--home', home, `--token=${token.token}`, '--name', 'Team Browser Worker'], origin).done
  assert.equal(registration.code, 0, 'owned Worker enrollment')
  const workerId = JSON.parse(registration.stdout).workerId
  worker = launch(['start', '--home', home, '--name', 'Team Browser Worker'], origin)
  await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities.some(item => item.agentKey === 'test' && item.availability.status === 'available'), 'Test Agent capability')
  const project = await api('/projects', 'POST', { name: 'Team browser placement', teamId: 'default-team', requestId: randomUUID() })
  const placed = await api('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Team browser empty Workspace', source: 'empty', requestId: randomUUID() })
  await eventually(() => api(`/workspaces/${placed.workspace.id}`), value => value.placements.some(item => item.workerId === workerId && item.status === 'ready'), 'ready Workspace')
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    step = `${name} first send`
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    contexts.push(context)
    assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: email, password } })).status(), 200, 'browser login')
    const page = await context.newPage()
    page.setDefaultTimeout(30000)
    page.on('pageerror', error => errors.push({ viewport: name, message: error.message }))
    await page.goto(`${origin}/next/teams`)
    const select = page.getByRole('combobox', { name: '协调执行环境' })
    await select.waitFor()
    await eventually(() => select.locator('option').count(), count => count > 1, 'authorized ready placement and Test Agent option')
    await select.selectOption({ index: 1 })
    const text = `browser-${name}-coordination-echo`
    await page.getByRole('textbox', { name: '协调首条消息' }).fill(text)
    await page.getByRole('button', { name: '发送并创建会话' }).click()
    const conversation = page.getByRole('region', { name: '任务会话对话' })
    await conversation.waitFor()
    await conversation.getByText(text).last().waitFor()
    await conversation.getByText(/Turn 已完成/).waitFor()
    const sessionId = await conversation.getAttribute('data-conversation-session')
    assert.ok(sessionId)
    checks.push(`${name}: actual Team first send and Test Agent result in conversation`)
    step = `${name} reload and restore`
    await page.reload()
    const listResponse = await context.request.get(`${origin}/api/teams/default-team/coordination/sessions`)
    assert.equal(listResponse.status(), 200, 'restore list authorization')
    const list = (await listResponse.json()).items
    const index = list.findIndex(item => item.id === sessionId)
    assert.ok(index >= 0, 'the same Session must be present after reload')
    await page.getByRole('button', { name: /团队协调（test）/ }).nth(index).click()
    await page.locator(`[data-conversation-session="${sessionId}"]`).waitFor()
    await page.getByText(text).last().waitFor()
    checks.push(`${name}: reload and restore same Task-bound Session and journal`)
    step = `${name} reopen new Session under original Task`
    await page.getByRole('button', { name: '在此 Task 下重开新会话' }).click()
    await page.getByRole('status').getByText(/将在原协调 Task 下新建会话/).waitFor()
    const reopenedText = `browser-${name}-reopened-echo`
    await page.getByRole('textbox', { name: '协调首条消息' }).fill(reopenedText)
    await page.getByRole('button', { name: '发送并创建会话' }).click()
    const reopened = page.getByRole('region', { name: '任务会话对话' })
    await reopened.waitFor()
    await reopened.getByText(reopenedText).last().waitFor()
    await reopened.getByText(/Turn 已完成/).waitFor()
    const reopenedId = await reopened.getAttribute('data-conversation-session')
    assert.ok(reopenedId && reopenedId !== sessionId, 'reopen creates another Session')
    const afterReopen = await context.request.get(`${origin}/api/teams/default-team/coordination/sessions`)
    assert.equal(afterReopen.status(), 200)
    const allSessions = (await afterReopen.json()).items
    const pair = allSessions.filter(item => item.id === sessionId || item.id === reopenedId)
    assert.equal(pair.length, 2, 'both Session histories retained')
    assert.equal(pair[0].taskId, pair[1].taskId, 'reopened Session uses the original Team Task')
    await page.getByRole('button', { name: /团队协调（test）/ }).nth(allSessions.findIndex(item => item.id === sessionId)).click()
    await page.locator(`[data-conversation-session="${sessionId}"]`).getByText(text).last().waitFor()
    checks.push(`${name}: explicit reopen keeps Team Task and original Session history`)
  }
  assert.deepEqual(errors, [], 'browser page errors')
  console.log(JSON.stringify({ status: 'pass', checks }))
} catch (error) {
  // Never print login, registration token or Worker stdout/stderr.
  console.error(JSON.stringify({ status: 'fail', step, message: error.message, checks, errors }))
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
