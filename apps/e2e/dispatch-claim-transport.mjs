#!/usr/bin/env node
/**
 * 票据 01（派发）：真实 Server + 两台真实 Worker 进程的机器范围、申领与接手链路。
 * 覆盖：范围外申领被拒、身份不能冒充、并发申领只产生一个有效承接、幂等重放、
 * 结果未知仍占位、release 语义、接手代次必须等被接替执行对账停止。
 * 断言全部来自真实 HTTP/凭证链路与真实 SQLite 行，不用测试替身冒充外部集成。
 * 用法：node --import tsx apps/e2e/dispatch-claim-transport.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createWemuxServer } from '../server/src/server.ts'
import { login } from './session.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { ownedWorkerLaunch, removeOwnedServerDatabases } from './owned-worker-fixture.mjs'

const root = await mkdtemp('/var/tmp/wemux-p01-dispatch-e2e-')
const database = join(root, 'server.sqlite')
const email = 'ticket01-owner@example.test', password = 'ticket01-owned-password'
const app = createWemuxServer({ databasePath: database, administratorEmails: [email], mail: {}, google: {} })
const workers = []
const steps = []

function launch(args, origin) {
  const isolated = ownedWorkerLaunch(args, origin)
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...isolated.args], { cwd: process.cwd(), env: isolated.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })) })
  void done.catch(() => {})
  return { child, done, logs: () => ({ stdout, stderr }) }
}

async function stop(worker) {
  if (!worker || worker.stopped) return
  worker.stopped = true
  const child = worker.process.child
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  // 必须用全局定时器：timers/promises 的 setTimeout 不能这样当强杀兜底用。
  const timer = globalThis.setTimeout(() => child.kill('SIGKILL'), 15000)
  try { await worker.process.done } finally { globalThis.clearTimeout(timer) }
}

async function eventually(read, accept, label, attempts = 600) {
  let latest
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await read()
    if (accept(latest)) return latest
    await delay(50)
  }
  const logs = workers.map(worker => `${worker.name}: ${JSON.stringify(worker.process.logs())}`).join('\n')
  assert.fail(`等待超时：${label}（最后状态 ${JSON.stringify(latest)}）\n${logs}`)
}

/** 真实 Worker 只能用自己的凭证申领；这里把凭证当 HTTP Bearer 使用，不伪造任何身份。 */
const workerFetch = async (origin, credential, path, method = 'GET', body) => {
  const response = await fetch(`${origin}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { status: response.status, ok: response.ok, data }
}

try {
  const origin = await app.listen(0)
  await seedLocalAccount(app.store, { username: email, email, password, administrator: true })
  const api = (await login(origin, email, password)).api
  await api('/bootstrap', 'POST', {})
  const project = await api('/projects', 'POST', { name: '票据01 派发', teamId: 'default-team', requestId: 'ticket01-project' })

  // 两台真实 Worker 进程：各自 register 拿到真实凭证，再 start 建立真实连接。
  for (const name of ['票据01 机器甲', '票据01 机器乙']) {
    const home = join(root, name === '票据01 机器甲' ? 'worker-a' : 'worker-b')
    const token = await api('/enrollment-tokens', 'POST', {})
    const registration = await launch(['register', '--home', home, `--token=${token.token}`, '--name', name], origin).done
    assert.equal(registration.code, 0, `register ${name}: ${registration.stderr}`)
    const credential = (await readFile(join(home, 'credential'), 'utf8')).trim()
    assert.ok(credential.length > 0, `${name} 必须拿到真实 Worker 凭证`)
    const worker = { name, home, credential, workerId: JSON.parse(registration.stdout).workerId }
    worker.process = launch(['start', '--home', home, '--name', name], origin)
    workers.push(worker)
  }
  for (const worker of workers) {
    await eventually(() => api(`/workers/${worker.workerId}`), value => value.connectionState === 'online', `${worker.name} 上线`)
    await eventually(() => api(`/workers/${worker.workerId}/capabilities`), value => value.capabilities.some(c => c.mode === 'execution' && c.availability.status === 'available'), `${worker.name} 上报可用执行 Agent`)
  }
  const [alpha, beta] = workers
  steps.push(`两台真实 Worker 在线：${alpha.workerId} / ${beta.workerId}`)

  const task = await api(`/projects/${project.id}/tasks`, 'POST', { title: '票据01 派发任务', requestId: 'ticket01-task' })
  const taskPath = `/projects/${project.id}/tasks/${task.id}`
  const dispatch = () => api(`${taskPath}/dispatch`)
  const scope = (body) => api(`${taskPath}/dispatch/machine-scope`, 'PUT', body)
  const claim = (worker, body) => workerFetch(origin, worker.credential, `/workers/${worker.workerId}/dispatch-claims`, 'POST', body)
  const release = (worker, claimId, body) => workerFetch(origin, worker.credential, `/workers/${worker.workerId}/dispatch-claims/${claimId}`, 'DELETE', body)

  // backlog 不派发：没有任何执行意图。
  assert.equal((await dispatch()).intent, null)
  assert.equal((await dispatch()).waitingReason, null)
  steps.push('backlog 不建立执行意图')

  // 进入 todo 自动参与派发，无需额外入队操作；未承接时给出可展示的等待原因。
  let view = await api(`${taskPath}`, 'PATCH', { status: 'todo', version: task.version })
  view = await dispatch()
  assert.equal(view.intent.kind, 'dispatch')
  assert.equal(view.intent.generation, 0)
  assert.equal(view.intent.queueOrder, 1)
  assert.ok(view.waitingReason, '未承接时必须给出等待原因')
  assert.equal(view.claim, null)
  const intentId = view.intent.intentId
  steps.push(`todo 建立执行意图 generation=0 queueOrder=1 waitingReason=${view.waitingReason}`)

  // 越权与范围：范围只能包含本次操作者能用的 Worker，未知 Worker 直接拒绝。
  const unknownFailure = await scope({ requestId: 'ticket01-scope-unknown', version: view.version, scope: { kind: 'fixed', workerId: 'worker-does-not-exist' } }).then(() => null, error => error)
  assert.ok(unknownFailure, '未知 Worker 不得进入机器范围')
  assert.match(String(unknownFailure.message ?? unknownFailure), /machine_scope_unauthorized/, '未知 Worker 必须以 machine_scope_unauthorized 被拒')
  const scoped = await scope({ requestId: 'ticket01-scope-a', version: (await api(taskPath)).version, scope: { kind: 'candidates', workerIds: [alpha.workerId] } })
  assert.equal(scoped.machineScope.kind, 'candidates')
  assert.deepEqual(scoped.machineScope.workerIds, [alpha.workerId])
  assert.equal(scoped.intent.intentId, intentId, '修改范围不得换掉已建立的执行意图')
  assert.equal(scoped.intent.queueOrder, 1, '修改范围不得重排入队序号')
  steps.push('机器范围写入被真实生效，未知 Worker 被拒，意图与入队序号保持不变')

  // 范围外机器申领被拒：越权在 API 层直接失败，不产生任何承接。
  const excluded = await claim(beta, { requestId: 'ticket01-beta-out-of-scope', intentId, generation: 0 })
  assert.equal(excluded.status, 409)
  assert.equal(excluded.data.error.code, 'worker_not_a_candidate')
  const spoof = await workerFetch(origin, beta.credential, `/workers/${alpha.workerId}/dispatch-claims`, 'POST', { requestId: 'ticket01-spoof', intentId, generation: 0 })
  assert.equal(spoof.status, 403, 'Worker 不能以别的 Worker 身份申领')
  assert.equal((await dispatch()).claim, null)
  steps.push('范围外申领 409 worker_not_a_candidate；冒用他人身份 403；未产生承接')

  // 并发申领：两个不同 requestId 同时到达，只有一台机器拿到有效承接。
  const [first, second] = await Promise.all([
    claim(alpha, { requestId: 'ticket01-alpha-claim', intentId, generation: 0 }),
    claim(beta, { requestId: 'ticket01-beta-claim', intentId, generation: 0 }),
  ])
  const accepted = [first, second].filter(result => result.status === 200)
  assert.equal(accepted.length, 1, `并发申领必须恰好一个成功：${JSON.stringify([first, second])}`)
  const rejected = [first, second].find(result => result.status !== 200)
  assert.ok(['worker_not_a_candidate', 'no_capacity', 'already_claimed', 'claim_already_held'].includes(rejected.data.error.code), `意外拒绝原因 ${JSON.stringify(rejected.data)}`)
  const winner = accepted[0].data.claim
  assert.equal(winner.state, 'reserved')
  view = await dispatch()
  assert.equal(view.claim.claimId, winner.claimId)
  assert.equal(view.waitingReason, null)
  steps.push(`并发申领恰好一个有效承接 ${winner.workerId}（另一台 ${rejected.data.error.code}）`)

  // 幂等重放：同一 requestId 重放返回同一条承接；换 Worker 复用同一 requestId 冲突。
  const owner = workers.find(worker => worker.workerId === winner.workerId)
  const other = workers.find(worker => worker.workerId !== winner.workerId)
  const replay = await claim(owner, { requestId: owner === alpha ? 'ticket01-alpha-claim' : 'ticket01-beta-claim', intentId, generation: 0 })
  assert.equal(replay.status, 200)
  assert.equal(replay.data.claim.claimId, winner.claimId)
  assert.equal(replay.data.changed, false)
  const conflict = await claim(other, { requestId: owner === alpha ? 'ticket01-alpha-claim' : 'ticket01-beta-claim', intentId, generation: 0 })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.data.error.code, 'request_id_conflict')
  steps.push('幂等重放返回同一承接；同一 requestId 跨机器复用冲突')

  // 结果未知（unknown）仍占位：不凭超时释放，也不允许第二个承接。
  await app.store.transaction(async tx => {
    await tx.tasks.saveDispatchClaim({ ...winner, state: 'unknown' })
  })
  view = await dispatch()
  assert.equal(view.claim.state, 'unknown')
  const blockedByUnknown = await claim(other, { requestId: 'ticket01-other-after-unknown', intentId, generation: 0 })
  assert.equal(blockedByUnknown.status, 409)
  steps.push(`结果未知的承接继续占位（另一台 ${blockedByUnknown.data.error.code}）`)

  // 释放：承接方本人声明已启动，意图保持已承接；别人的释放被拒。
  assert.equal((await release(other, winner.claimId, { requestId: 'ticket01-foreign-release', reason: 'declined' })).status, 403)
  const started = await release(owner, winner.claimId, { requestId: 'ticket01-release-started', reason: 'started' })
  assert.equal(started.status, 200)
  assert.equal(started.data.claim.state, 'released')
  assert.equal(started.data.claim.releasedReason, 'started')
  view = await dispatch()
  assert.equal(view.intent.state, 'claimed', 'started 释放不得把意图退回待安排')
  steps.push('非承接方释放 403；本人 started 释放后意图保持已承接')

  // 接手：in_progress 下明确安排新 Session，绑定被接替的承接身份并推进代次。
  await api(taskPath, 'PATCH', { status: 'in_progress', version: (await api(taskPath)).version })
  const handoff = await api(`${taskPath}/dispatch/handoff`, 'POST', { requestId: 'ticket01-handoff', version: (await api(taskPath)).version, machineScope: { kind: 'candidates', workerIds: [other.workerId] }, execution: { agentKey: 'test', modelId: 'test' } })
  assert.equal(handoff.generation, winner.generation + 1)
  view = await dispatch()
  assert.equal(view.intent.kind, 'handoff')
  assert.deepEqual(view.intent.machineScope.workerIds, [other.workerId])
  assert.equal(view.intent.supersedes.claimId, winner.claimId)
  assert.equal(view.intent.supersedes.workerId, winner.workerId)
  steps.push(`接手意图 generation=${view.intent.generation} 绑定被接替承接 ${winner.claimId}`)

  // 旧执行只声明过「已启动」，没有对账结论前不得被接手：越过交接边界复活被拒。
  const early = await claim(other, { requestId: 'ticket01-handoff-early', intentId: view.intent.intentId, generation: view.intent.generation })
  assert.equal(early.status, 409)
  assert.equal(early.data.error.code, 'prior_execution_in_flight')
  const stale = await claim(other, { requestId: 'ticket01-handoff-stale', intentId: view.intent.intentId, generation: 0 })
  assert.equal(stale.status, 409)
  assert.equal(stale.data.error.code, 'claim_stale_generation')
  steps.push('旧执行未对账停止时接手 409 prior_execution_in_flight；过期代次 409 claim_stale_generation')

  // 承接方本人对账确认停止后才放行接手；被接替的承接记录保留。
  assert.equal((await release(other, winner.claimId, { requestId: 'ticket01-reconcile-forged', reason: 'reconciled_stopped' })).status, 403)
  const reconciled = await release(owner, winner.claimId, { requestId: 'ticket01-reconcile', reason: 'reconciled_stopped' })
  assert.equal(reconciled.data.claim.releasedReason, 'reconciled_stopped')
  const takeover = await claim(other, { requestId: 'ticket01-handoff-claim', intentId: view.intent.intentId, generation: view.intent.generation })
  assert.equal(takeover.status, 200, JSON.stringify(takeover.data))
  assert.equal(takeover.data.claim.workerId, other.workerId)
  assert.equal(takeover.data.claim.generation, view.intent.generation)
  const identities = await app.store.transaction(async tx => ({ old: await tx.tasks.dispatchClaim(winner.claimId), next: await tx.tasks.activeDispatchClaim(view.intent.intentId) }))
  assert.equal(identities.old.workerId, winner.workerId, '被接替的承接记录必须保留')
  assert.equal(identities.next.claimId, takeover.data.claim.claimId)
  steps.push('对账停止后接手成功，旧承接记录保留，新承接代次独立')

  // 终态阻断：任务取消后执行意图不再可被消费；已被有效承接的记录保留，不静默撤销执行事实。
  await api(taskPath, 'PATCH', { status: 'blocked', version: (await api(taskPath)).version })
  await api(taskPath, 'PATCH', { status: 'cancelled', version: (await api(taskPath)).version })
  const afterCancel = await claim(other, { requestId: 'ticket01-after-cancel', intentId: view.intent.intentId, generation: view.intent.generation })
  assert.equal(afterCancel.status, 409)
  assert.equal(afterCancel.data.error.code, 'intent_not_dispatchable', JSON.stringify(afterCancel.data))
  view = await dispatch()
  assert.equal(view.intent.state, 'claimed', '已承接的执行记录不得被任务终态静默撤销')
  assert.equal(view.waitingReason, null)
  const claims = await app.store.transaction(async tx => ({ active: await tx.tasks.activeDispatchClaim(view.intent.intentId), old: await tx.tasks.dispatchClaim(winner.claimId), history: await tx.tasks.dispatchClaimsByWorker(owner.workerId) }))
  assert.equal(claims.active.claimId, takeover.data.claim.claimId)
  assert.equal(claims.old.state, 'released', '被接替的承接记录不得被删除')
  assert.ok(claims.history.some(claim => claim.claimId === winner.claimId), '被接替的承接仍在承接方历史里')
  steps.push(`取消后不能再申领（${afterCancel.data.error.code}），已承接记录保留`)

  console.log('# 票据01 派发真实链路验收\n')
  for (const step of steps) console.log(`- ${step}`)
  console.log(`\n结果：${steps.length} 项真实链路断言全部通过`)
} finally {
  for (const worker of workers) await stop(worker).catch(() => {})
  await app.close()
  await removeOwnedServerDatabases(database)
  await rm(root, { recursive: true, force: true })
}
