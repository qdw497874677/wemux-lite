#!/usr/bin/env node
/** Ticket 04: 跨 Team / Project / Worker / Session 授权矩阵（负例为主，HTTP 级真实 Server）。
 * 覆盖：非成员跨 Team 探测（availability / sessions / 首发全被成员资格门拦截，不泄漏存在性）；
 * Team 成员但非 Project contributor：列表只见自己的会话，读/写/停止/审批代决他人协调会话全被拒；
 * Project 未授权的首发被拒（管理员正例对照证明非空转）；Workspace 与 Worker 落点不匹配首发被拒；
 * 伪造 workspaceId/workerId 404；普通 Task 会话权限无回归；所有拒绝响应不泄漏会话内容标记。
 * 仅用确定性 Test Agent；无付费模型、无真实 Pi；不使用持久用户数据。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createWemuxServer } from '../server/src/server.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { login } from './session.ts'
import { ownedWorkerLaunch, removeOwnedServerDatabases } from './owned-worker-fixture.mjs'

const dir = await mkdtemp(join(tmpdir(), 'wemux-authz-matrix-'))
const database = join(dir, 'server.sqlite')
const adminEmail = 'authz-admin@example.test', bobEmail = 'authz-bob@example.test', carolEmail = 'authz-carol@example.test'
const password = 'authz-matrix-test-only-password'
const secret = `authz-secret-${randomUUID()}`
// 不传 mail：Team 邀请直接入库，跳过投递（本地验收路径）。
const app = createWemuxServer({ databasePath: database, administratorEmails: [adminEmail], google: {} })
const workers = [], checks = [], errors = []
const eventually = async (read, accept, label, windowMs = 30000) => {
  const deadline = Date.now() + windowMs
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
const denied = result => result.status === 403 || result.status === 404
const rejected = result => result.status >= 400 && result.status < 500
const noLeak = result => JSON.stringify(result.data ?? '').includes(secret) === false
const firstSend = (workspaceId, workerId, actorId) => ({ requestId: randomUUID(), commandId: randomUUID(), workspaceId, workerId, agentKey: 'test', modelId: 'test', content: `${secret} from ${actorId}` })
try {
  const origin = await app.listen(0)
  await seedLocalAccount(app.store, { username: adminEmail, email: adminEmail, password, administrator: true })
  await seedLocalAccount(app.store, { username: bobEmail, email: bobEmail, password })
  await seedLocalAccount(app.store, { username: carolEmail, email: carolEmail, password })
  const admin = await login(origin, adminEmail, password), bob = await login(origin, bobEmail, password), carol = await login(origin, carolEmail, password)
  await admin.api('/bootstrap', 'POST', {})
  const homes = [join(dir, 'worker1'), join(dir, 'worker2')]
  for (const [index, home] of homes.entries()) {
    // 注册令牌一次一换：每个 Worker 单独领一枚，避免单次消费后第二枚 401。
    const issued = await admin.api('/enrollment-tokens', 'POST', {})
    const registration = await launch(['register', '--home', home, `--token=${issued.token}`, `--name=authz-worker-${index + 1}`], origin).done
    assert.equal(registration.code, 0, `owned Worker enrollment: ${registration.stderr.slice(-300)}`)
    workers.push(launch(['start', '--home', home, `--name=authz-worker-${index + 1}`], origin))
  }
  const items = await eventually(() => admin.api('/workers'), value => value.items.filter(item => item.connectionState === 'online').length >= 2, 'two Workers online')
  const [worker1, worker2] = items.items.map(item => item.id)
  await eventually(() => admin.api(`/workers/${worker1}/capabilities`), value => value.capabilities.some(item => item.agentKey === 'test' && item.availability.status === 'available'), 'Test Agent capability on worker1')
  const project1 = await admin.api('/projects', 'POST', { name: 'authz P1', teamId: 'default-team', requestId: randomUUID() })
  const project2 = await admin.api('/projects', 'POST', { name: 'authz P2', teamId: 'default-team', requestId: randomUUID() })
  const place = async projectId => {
    const created = await admin.api('/workspaces', 'POST', { projectId, workerId: worker1, name: `authz W ${projectId}`, source: 'empty', requestId: randomUUID() })
    await eventually(() => admin.api(`/workspaces/${created.workspace.id}`), value => value.placements.some(item => item.workerId === worker1 && item.status === 'ready'), 'ready placement')
    return created.workspace.id
  }
  const workspace1 = await place(project1.id), workspace2 = await place(project2.id)
  // bob 通过邀请加入 default-team（成员但无任何 Project 角色）；carol 自建 Team，完全非成员。
  const invitation = await admin.api('/teams/default-team/invitations', 'POST', { email: bobEmail })
  assert.equal((await bob.raw(`/team-invitations/${invitation.token}/accept`, 'POST', {})).status, 200, 'bob accepts invitation')
  const carolTeam = await carol.api('/teams', 'POST', { name: 'carol-team' })
  // 正例对照：admin 首发成功（证明后续负例不是空转）。
  const positive = await admin.raw('/teams/default-team/coordination/sessions', 'POST', firstSend(workspace1, worker1, 'admin'))
  assert.equal(positive.status, 201, 'admin first send positive control')
  const sessionId = positive.data.session.id
  assert.ok(positive.data.session.taskId.startsWith('coordination:'), 'coordination Task bound')
  checks.push('positive control: owner first send creates the coordination session')
  const normalSession = await admin.raw('/sessions', 'POST', { requestId: randomUUID(), workspaceId: workspace1, workerId: worker1, agentKey: 'test', modelId: 'test', title: `authz normal ${secret}` })
  assert.equal(normalSession.status, 201, `normal session created for regression probe: ${JSON.stringify(normalSession.data).slice(0, 300)}`)
  const normalId = normalSession.data.id ?? normalSession.data.session?.id
  const step = []
  const expect = async (actor, label, path, method, body, ok = denied) => {
    const result = await actor.raw(path, method, body)
    assert.ok(ok(result), `${label}: expected rejection, got ${result.status} ${JSON.stringify(result.data)}`)
    assert.ok(noLeak(result), `${label}: denial leaked session content`)
    step.push(`${label} -> ${result.status}`)
    return result
  }
  // 1. carol（跨 Team 非成员）探测 Team A 协调入口与会话本体。
  await expect(carol, 'carol availability', '/teams/default-team/coordination/availability')
  await expect(carol, 'carol session list', '/teams/default-team/coordination/sessions')
  await expect(carol, 'carol first send', '/teams/default-team/coordination/sessions', 'POST', firstSend(workspace1, worker1, 'carol'))
  await expect(carol, 'carol read coordination session', `/sessions/${sessionId}`)
  await expect(carol, 'carol read coordination events', `/sessions/${sessionId}/events?fromSeq=1&limit=50`)
  await expect(carol, 'carol write message', `/sessions/${sessionId}/messages`, 'POST', { requestId: randomUUID(), commandId: randomUUID(), content: `${secret} carol write` })
  await expect(carol, 'carol stop turn', `/sessions/${sessionId}/turn/stop`, 'POST', { requestId: randomUUID(), commandId: randomUUID() })
  await expect(carol, 'carol resolve approval', `/sessions/${sessionId}/runtime/approvals/${encodeURIComponent('fake:approval')}`, 'POST', { commandId: randomUUID(), turnId: 'turn-x', decision: 'approve' })
  await expect(carol, 'carol read normal session', `/sessions/${normalId}`)
  checks.push('non-member cross-Team probes are denied on availability, list, first send and the session itself without content leaks')
  // 2. bob（Team 成员、无 Project contributor）。
  const bobList = await bob.api('/teams/default-team/coordination/sessions')
  assert.equal(bobList.items.some(item => item.id === sessionId), false, 'bob must not see owner sessions in the list')
  assert.equal(bobList.items.length, 0, 'bob sees only his own (none yet)')
  await expect(bob, 'bob read coordination session', `/sessions/${sessionId}`)
  await expect(bob, 'bob read coordination events', `/sessions/${sessionId}/events?fromSeq=1&limit=50`)
  await expect(bob, 'bob write message', `/sessions/${sessionId}/messages`, 'POST', { requestId: randomUUID(), commandId: randomUUID(), content: `${secret} bob write` })
  await expect(bob, 'bob stop turn', `/sessions/${sessionId}/turn/stop`, 'POST', { requestId: randomUUID(), commandId: randomUUID() })
  await expect(bob, 'bob resolve approval', `/sessions/${sessionId}/runtime/approvals/${encodeURIComponent('fake:approval')}`, 'POST', { commandId: randomUUID(), turnId: 'turn-x', decision: 'approve' })
  await expect(bob, 'bob first send P1 (no contributor)', '/teams/default-team/coordination/sessions', 'POST', firstSend(workspace1, worker1, 'bob'))
  await expect(bob, 'bob first send P2 (no contributor)', '/teams/default-team/coordination/sessions', 'POST', firstSend(workspace2, worker1, 'bob'))
  await expect(bob, 'bob read normal session', `/sessions/${normalId}`)
  await expect(bob, 'bob fs list foreign session', `/sessions/${sessionId}/fs/list`, 'POST', { subpath: '' })
  checks.push('Team member without Project contributor cannot list, read, write, stop, approve or first-send on foreign resources')
  // 3. Worker / Workspace 落点矩阵（admin 有权，但组合不合法；结构拒绝是 4xx 而非 2xx）。
  await expect(admin, 'first send worker2 without placement', '/teams/default-team/coordination/sessions', 'POST', firstSend(workspace1, worker2, 'admin'), rejected)
  await expect(admin, 'first send bogus workspace', '/teams/default-team/coordination/sessions', 'POST', firstSend('ws_missing', worker1, 'admin'), rejected)
  await expect(admin, 'first send bogus worker', '/teams/default-team/coordination/sessions', 'POST', firstSend(workspace1, 'wk_missing', 'admin'), rejected)
  await expect(admin, 'normal session bogus worker', '/sessions', 'POST', { requestId: randomUUID(), workspaceId: workspace1, workerId: 'wk_missing', agentKey: 'test', modelId: 'test', title: 'authz bogus worker' }, rejected)
  checks.push('Workspace/Worker placement mismatch and fabricated ids are rejected even for an authorized owner')
  // 4. 反向跨 Team 探测：bob/admin 不是 carol-team 成员，读不到另一个 Team 的协调入口。
  await expect(bob, 'bob probes carol-team availability', `/teams/${carolTeam.id}/coordination/availability`)
  await expect(bob, 'bob probes carol-team sessions', `/teams/${carolTeam.id}/coordination/sessions`)
  await expect(admin, 'instance admin without membership probes carol-team', `/teams/${carolTeam.id}/coordination/sessions`)
  checks.push('reverse cross-Team probes (including instance admin without membership) stay membership-gated')
  console.log(JSON.stringify({ status: 'pass', checks, probes: step.length }))
} catch (error) {
  // 不打印登录凭据、注册令牌或 Worker stdout/stderr。
  console.error(JSON.stringify({ status: 'fail', errorName: error?.name ?? 'Error', message: String(error?.message ?? ''), checks }))
  process.exitCode = 1
} finally {
  for (const worker of workers) {
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
