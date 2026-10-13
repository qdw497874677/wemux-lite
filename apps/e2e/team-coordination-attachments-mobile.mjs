#!/usr/bin/env node
/** Owned Server + Worker + Test Agent + actual /next/ mobile-viewport Chromium two-phase attachment upload.
 * 票据 05 第 2 项：票据 04 手机验收脚本不含上传链路，本脚本在手机视口（390×844，isMobile/hasTouch）
 * 走完整两阶段上传：选文件 → 阶段一 Server 有界收件 + Task/Session 原子绑定（Worker 离线如实「待投递」）
 * → 阶段二 Worker 恢复后投递原字节 → Test Agent read-file 在同一手机会话内实际读取并回显摘要。
 * WEMUX_NEXT_TEST_DIST=/tmp/... PLAYWRIGHT_CORE_PATH=... PLAYWRIGHT_CHROMIUM_PATH=...
 * TMPDIR must support SQLite WAL (on this host, use a disk directory rather than /tmp).
 * No paid Runtime, production credentials, or persistent user data.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
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
const dir = await mkdtemp(join(tmpdir(), 'wemux-attachments-mobile-'))
const database = join(dir, 'server.sqlite'), home = join(dir, 'worker')
const email = 'attachments-mobile-owner@example.test', password = 'attachments-mobile-test-only-password'
const app = createWemuxServer({ databasePath: database, administratorEmails: [email], mail: {}, google: {}, webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST) })
let worker, browser, step = 'setup'
const checks = [], errors = []
const eventually = async (read, accept, label, timeout = 30000) => {
  const deadline = Date.now() + timeout
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
async function stopWorker(live) {
  if (live.child.exitCode === null && live.child.signalCode === null) live.child.kill('SIGTERM')
  const stopped = await live.done
  assert.equal(stopped.code, 0, `owned Worker graceful stop: ${stopped.stderr}`)
}
const digestOf = bytes => createHash('sha256').update(bytes).digest('hex')
async function findWorkspaceFile(root, subpath) {
  const target = subpath.split('/').at(-1)
  const queue = [root]
  while (queue.length) {
    const current = queue.shift()
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (entry.name === target) return full
    }
  }
  throw Error(`Delivered attachment not found under ${root}: ${subpath}`)
}
try {
  const origin = await app.listen(0)
  await seedLocalAccount(app.store, { username: email, email, password, administrator: true })
  const { api } = await login(origin, email, password)
  await api('/bootstrap', 'POST', {})
  step = 'enroll Worker'
  const enrollment = await api('/enrollment-tokens', 'POST', {})
  const registration = await launch(['register', '--home', home, `--token=${enrollment.token}`, '--name', 'Attachment Mobile Worker'], origin).done
  assert.equal(registration.code, 0, `owned Worker enrollment: ${registration.stderr}`)
  const workerId = JSON.parse(registration.stdout).workerId
  worker = launch(['start', '--home', home, '--name', 'Attachment Mobile Worker'], origin)
  await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities.some(agent => agent.agentKey === 'test' && agent.availability.status === 'available' && agent.attachments === true), 'Test Agent attachment capability online')
  step = 'prepare authorized Workspace'
  const project = await api('/projects', 'POST', { name: 'Attachment Mobile Project', teamId: 'default-team', requestId: randomUUID() })
  const provision = await api('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Attachment Mobile Workspace', source: 'empty', requestId: randomUUID() })
  const workspaceId = provision.workspace.id
  await eventually(() => api(`/workspaces/${workspaceId}`), value => value.placements.some(placement => placement.workerId === workerId && placement.status === 'ready'), 'ready Workspace placement')

  step = 'mobile viewport opens upload entry only for a chosen attachments-capable Agent'
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: email, password } })).status(), 200, 'browser login')
  const page = await context.newPage()
  page.setDefaultTimeout(30000)
  page.on('pageerror', () => errors.push({ step }))
  await page.goto(`${origin}/next/teams`)
  const select = page.getByRole('combobox', { name: '协调执行环境' })
  await select.waitFor()
  await eventually(() => select.locator('option').count(), count => count > 1, 'mobile ready placement with Test Agent option')
  const fileInput = page.locator('input[aria-label="协调附件"]')
  assert.equal(await fileInput.isDisabled(), true, '未选执行环境时手机上传入口不可用')
  await select.selectOption({ index: 1 })
  assert.equal(await fileInput.isDisabled(), false, '声明附件能力的 Test Agent 在手机上开启上传入口')
  checks.push('mobile 390×844: upload entry stays closed until an attachments-capable Agent is chosen')

  step = '阶段一：Worker 离线时手机选文件上传，如实呈现待投递'
  await stopWorker(worker)
  worker = null
  await eventually(() => api('/workers'), value => value.items.find(item => item.id === workerId)?.connectionState === 'offline', 'Worker offline projection')
  const bytes = Buffer.from('手机附件原始字节 mobile hello 附件\nsecond line 0123456789\n')
  const sha256 = digestOf(bytes)
  await fileInput.setInputFiles({ name: '手机笔记.txt', mimeType: 'text/plain', buffer: bytes })
  await page.getByRole('button', { name: '上传附件并创建会话' }).click()
  const pendingStatus = page.locator('[data-attachment-state="pending"]')
  await pendingStatus.waitFor()
  const pendingText = await pendingStatus.textContent()
  assert.ok(pendingText?.includes(`Server 已收件「手机笔记.txt」（${bytes.length} 字节）`), `阶段一收件文案：${pendingText}`)
  assert.ok(pendingText?.includes('待投递'), `Worker 离线待投递：${pendingText}`)
  assert.ok(pendingText?.includes('Worker 当前离线，恢复后自动续签投递'), `Worker 离线如实提示：${pendingText}`)
  const subpathMatch = /工作区内路径 (\S+)。/.exec(pendingText ?? '')
  assert.ok(subpathMatch, `subpath 可从手机状态文案提取：${pendingText}`)
  const subpath = subpathMatch[1]
  assert.match(subpath, /^attachments\//)
  checks.push('阶段一：手机选文件上传，Worker 离线时如实「待投递」与「恢复后自动续签投递」')

  step = '阶段一绑定协调 Task/Session 且不虚构首条消息'
  const conversation = page.getByRole('region', { name: '任务会话对话' })
  await conversation.waitFor()
  const sessionId = await conversation.getAttribute('data-conversation-session')
  assert.ok(sessionId, '上传即创建并选中会话（手机视口）')
  const listed = await eventually(() => api('/teams/default-team/coordination/sessions'), value => value.items.some(item => item.id === sessionId), 'Session listed')
  const bound = listed.items.find(item => item.id === sessionId)
  assert.ok(bound?.taskId?.startsWith('coordination:'), `上传原子绑定协调 Task：${bound?.taskId}`)
  const initialJournal = await api(`/sessions/${sessionId}/events?fromSeq=1&limit=1000`)
  assert.equal(initialJournal.events.length, 0, '上传不虚构首条消息，会话日志为空')
  await conversation.getByText('暂无已验证的会话历史').waitFor()
  checks.push('阶段一：上传原子绑定协调 Task/Session，不虚构首条消息（日志为空）')

  step = '阶段二：Worker 恢复后投递原字节，手机 UI 轮询翻转为已投递'
  worker = launch(['start', '--home', home, '--name', 'Attachment Mobile Worker'], origin)
  await eventually(() => api('/workers'), value => value.items.find(item => item.id === workerId)?.connectionState === 'online', 'Worker reconnect')
  const deliveredStatus = page.locator('[data-attachment-state="delivered"]')
  await deliveredStatus.waitFor()
  assert.ok((await deliveredStatus.textContent())?.includes('已投递'), '阶段二已投递文案')
  const onDisk = await findWorkspaceFile(join(home, 'workspaces'), subpath)
  const stored = await readFile(onDisk)
  assert.equal(stored.length, bytes.length, '落盘附件必须是原字节')
  assert.equal(digestOf(stored), sha256, '落盘附件 sha256 必须一致')
  checks.push('阶段二：Worker 恢复后手机 UI 轮询翻转为「已投递」，工作区落盘为原字节（sha256 一致）')

  step = '同一手机会话内 Agent read-file 读取附件原字节并回显摘要'
  await conversation.getByRole('textbox', { name: '新消息草稿' }).fill(`[test-agent:read-file] ${subpath}`)
  await conversation.getByRole('button', { name: '发送新消息' }).click()
  // Worker 刚重启，重连退避最长 30s；预算需覆盖重连 + Turn 执行，默认 30s 不够（主树复验曾 1/3 超时）
  await conversation.getByText('Turn 已完成').waitFor({ timeout: 75000 })
  await conversation.getByText(`Read ${subpath}: sha256=${sha256} size=${bytes.length}`).waitFor()
  const journal = await api(`/sessions/${sessionId}/events?fromSeq=1&limit=1000`)
  const echoed = journal.events.filter(event => event.payload.kind === 'assistant.text.delta').map(event => event.payload.text).join('')
  assert.ok(echoed.includes(`sha256=${sha256}`) && echoed.includes(`size=${bytes.length}`), '权威 Journal 回显摘要')
  checks.push('手机会话内 read-file：Test Agent 实际读取附件原字节并回显 sha256/size（UI 与权威 Journal 双证）')

  step = '手机刷新后恢复同一协调 Task 会话与历史'
  await page.reload()
  await page.getByRole('button', { name: /团队协调（test）/ }).first().click()
  await page.locator(`[data-conversation-session="${sessionId}"]`).waitFor()
  await page.locator(`[data-conversation-session="${sessionId}"]`).getByText(`sha256=${sha256}`).waitFor()
  const restored = await api('/teams/default-team/coordination/sessions')
  assert.equal(restored.items.find(item => item.id === sessionId)?.taskId, bound.taskId, '刷新后同一协调 Task')
  checks.push('手机刷新恢复同一协调 Task 会话与已验证历史')

  assert.deepEqual(errors, [], 'browser page errors')
  console.log(JSON.stringify({
    status: 'pass',
    viewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
    checks,
    attachment: { sessionId, taskId: bound.taskId, subpath, sha256, size: bytes.length, deliveredFile: onDisk },
  }))
} catch (error) {
  // Never print login, registration token or Worker stdout/stderr.
  console.error(JSON.stringify({ status: 'fail', step, errorName: error?.name ?? 'Error', errorMessage: error?.message ?? String(error), checks, pageErrorCount: errors.length }))
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => { process.exitCode = 1 })
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
