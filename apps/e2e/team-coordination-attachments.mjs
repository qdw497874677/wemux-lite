#!/usr/bin/env node
/** Owned Server + Worker + Test Agent attachment delivery end-to-end. No paid runtime.
 *
 * 票据 04 上传切片的整链验收：
 * - 阶段一：Server 有界收件 + Task/Session 元数据原子绑定（Worker 离线时如实「待投递」）。
 * - 阶段二：Worker 恢复后按依赖顺序投递，附件落盘为原字节，Test Agent read-file fixture 实际读取并回显摘要。
 * - 负例：同一意图幂等重放、冲突拒绝、撤权后新上传拒绝且在途投递投影为失败。
 * - 失败后的用户路径（票据 05 第 3 项，引导重建）：失败附件原意图重放只回放失败记录不复活；
 *   同文件换新 requestId、换可用节点重传畅通且端到端落盘成功，失败历史保留。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createWemuxServer } from '../server/src/server.ts'
import { login } from './session.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { ownedWorkerLaunch, removeOwnedServerDatabases } from './owned-worker-fixture.mjs'

const directory = await mkdtemp(join(tmpdir(), 'wemux-coordination-attachments-'))
const database = join(directory, 'server.sqlite'), home = join(directory, 'worker')
const email = 'coordination-attachments@example.test', password = 'coordination-attachments-password'
const app = createWemuxServer({ databasePath: database, administratorEmails: [email], mail: {}, google: {} })
let worker, step = 'setup'
function launch(args, origin) {
  const isolated = ownedWorkerLaunch(args, origin)
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...isolated.args], { cwd: process.cwd(), env: isolated.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', value => { stdout += value })
  child.stderr.on('data', value => { stderr += value })
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })) })
  void done.catch(() => {})
  return { child, done, logs: () => ({ stdout, stderr }) }
}
async function eventually(read, accept, label, timeout = 30000) {
  const limit = Date.now() + timeout
  while (Date.now() < limit) {
    const value = await read()
    if (accept(value)) return value
    await delay(100)
  }
  throw Error(`Timed out: ${label}`)
}
async function stopWorker(live) {
  if (live.child.exitCode === null && live.child.signalCode === null) live.child.kill('SIGTERM')
  const stopped = await live.done
  assert.equal(stopped.code, 0, `Worker graceful stop: ${stopped.stderr}`)
}
const digestOf = bytes => createHash('sha256').update(bytes).digest('hex')
async function findWorkspaceFile(root, subpath) {
  const target = subpath.split('/').at(-1)
  const queue = [root]
  while (queue.length) {
    const dir = queue.shift()
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (entry.name === target) return full
    }
  }
  throw Error(`Delivered attachment not found under ${root}: ${subpath}`)
}
try {
  const origin = await app.listen(0)
  await seedLocalAccount(app.store, { username: email, email, password, administrator: true })
  const { api, cookie, csrfToken } = await login(origin, email, password)
  const upload = async (fields, file) => {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(file.bytes)], { type: 'text/plain' }), file.name)
    for (const [key, value] of Object.entries(fields)) form.append(key, value)
    const response = await fetch(`${origin}/api/teams/default-team/coordination/attachments`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken }, body: form })
    return { status: response.status, data: await response.json().catch(() => null) }
  }
  await api('/bootstrap', 'POST', {})
  step = 'enroll Worker'
  const enrollment = await api('/enrollment-tokens', 'POST', {})
  const registered = await launch(['register', '--home', home, `--token=${enrollment.token}`, '--name', 'Owned Attachment Worker'], origin).done
  assert.equal(registered.code, 0, `Worker registration: ${registered.stderr}`)
  const workerId = JSON.parse(registered.stdout).workerId
  worker = launch(['start', '--home', home, '--name', 'Owned Attachment Worker'], origin)
  const capabilities = await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities.some(agent => agent.agentKey === 'test' && agent.availability.status === 'available'), 'Test Agent online')
  assert.equal(capabilities.capabilities.find(agent => agent.agentKey === 'test').attachments, true, 'Test Agent 必须如实上报附件读取能力')
  step = 'prepare authorized Workspace'
  const project = await api('/projects', 'POST', { name: 'Attachment Test Project', teamId: 'default-team', requestId: randomUUID() })
  const provision = await api('/workspaces', 'POST', { projectId: project.id, workerId, name: 'Attachment Workspace', source: 'empty', requestId: randomUUID() })
  const workspaceId = provision.workspace.id
  await eventually(() => api(`/workspaces/${workspaceId}`), space => space.placements.some(placement => placement.workerId === workerId && placement.status === 'ready'), 'ready Workspace placement')

  step = '阶段一：Worker 离线时有界收件并原子绑定元数据'
  await stopWorker(worker)
  worker = null
  const bytes = Buffer.from('附件原始字节 hello 附件\nsecond line 0123456789\n')
  const sha256 = digestOf(bytes)
  const intent = { requestId: randomUUID(), workspaceId, workerId, agentKey: 'test', modelId: 'test' }
  const first = await upload(intent, { name: '笔记.txt', bytes })
  assert.equal(first.status, 201, JSON.stringify(first.data))
  assert.equal(first.data.created, true)
  assert.equal(first.data.attachment.sha256, sha256)
  assert.equal(first.data.attachment.delivery.state, 'pending', 'Worker 离线：阶段二如实呈现待投递')
  const session = first.data.session
  assert.ok(session.taskId.startsWith('coordination:'), '上传即创建协调 Task，不虚构首条消息')
  assert.equal((await api(`/teams/default-team/coordination/sessions`)).items.some(item => item.id === session.id), true)

  step = '同一意图幂等、冲突拒绝'
  const replay = await upload(intent, { name: '笔记.txt', bytes })
  assert.equal(replay.status, 201)
  assert.equal(replay.data.created, false)
  assert.equal(replay.data.session.id, session.id)
  assert.equal(replay.data.attachment.id, first.data.attachment.id)
  const conflict = await upload(intent, { name: '笔记.txt', bytes: Buffer.from('不同的字节') })
  assert.equal(conflict.status, 409, JSON.stringify(conflict.data))

  step = '阶段二：Worker 恢复后投递原字节到工作区'
  worker = launch(['start', '--home', home, '--name', 'Owned Attachment Worker'], origin)
  const view = () => api(`/teams/default-team/coordination/attachments/${first.data.attachment.id}`)
  await eventually(view, value => value.attachment.delivery.state === 'delivered', 'attachment delivered after worker restart')
  const subpath = first.data.attachment.subpath
  const onDisk = await findWorkspaceFile(join(home, 'workspaces'), subpath)
  const stored = await readFile(onDisk)
  assert.equal(stored.length, bytes.length, '落盘附件必须是原字节')
  assert.equal(digestOf(stored), sha256, '落盘附件 sha256 必须一致')

  step = 'Agent 实际读取附件原字节并回显摘要'
  const sent = await api(`/sessions/${session.id}/messages`, 'POST', { commandId: randomUUID(), content: `[test-agent:read-file] ${subpath}` })
  assert.ok(sent.commandId)
  const journal = () => api(`/sessions/${session.id}/events?fromSeq=1&limit=1000`)
  let echoed = ''
  await eventually(journal, value => {
    echoed = value.events.filter(event => event.payload.kind === 'assistant.text.delta').map(event => event.payload.text).join('')
    return echoed.includes(`sha256=${sha256}`) && echoed.includes(`size=${bytes.length}`)
  }, 'Test Agent read-file echo')
  assert.match(echoed, new RegExp(`Read ${subpath.replaceAll('.', '\\.')}: sha256=`))

  step = '撤权：在途投递失败、新上传拒绝'
  await stopWorker(worker)
  worker = null
  const secondIntent = { ...intent, requestId: randomUUID() }
  const second = await upload(secondIntent, { name: '第二份.txt', bytes: Buffer.from('pending attachment') })
  assert.equal(second.status, 201)
  assert.equal(second.data.attachment.delivery.state, 'pending')
  await api(`/workers/${workerId}/revoke`, 'POST', {})
  const revokedUpload = await upload({ ...intent, requestId: randomUUID() }, { name: '第三份.txt', bytes: Buffer.from('after revoke') })
  assert.equal(revokedUpload.status, 409, JSON.stringify(revokedUpload.data))
  await eventually(() => api(`/teams/default-team/coordination/attachments/${second.data.attachment.id}`), value => value.attachment.delivery.state === 'failed', '在途投递投影为失败')
  const failedView = await api(`/teams/default-team/coordination/attachments/${second.data.attachment.id}`)
  assert.match(failedView.attachment.delivery.detail ?? '', /撤销/)
  const deliveredStill = await view()
  assert.equal(deliveredStill.attachment.delivery.state, 'delivered', '已投递的历史事实不被撤权改写')

  step = '失败后的用户路径：原意图重放只回放失败记录，同文件新请求重传畅通'
  const failedReplay = await upload(secondIntent, { name: '第二份.txt', bytes: Buffer.from('pending attachment') })
  assert.equal(failedReplay.status, 201, JSON.stringify(failedReplay.data))
  assert.equal(failedReplay.data.created, false, '失败意图重放幂等回原 Session，不重复入队')
  assert.equal(failedReplay.data.attachment.id, second.data.attachment.id)
  assert.equal(failedReplay.data.attachment.delivery.state, 'failed', '重放不复活失败投递，UI 必须引导换新上传')

  const secondEnrollment = await api('/enrollment-tokens', 'POST', {})
  const homeB = join(directory, 'worker-b')
  const registeredB = await launch(['register', '--home', homeB, `--token=${secondEnrollment.token}`, '--name', 'Owned Attachment Worker B'], origin).done
  assert.equal(registeredB.code, 0, `Worker B registration: ${registeredB.stderr}`)
  const workerIdB = JSON.parse(registeredB.stdout).workerId
  worker = launch(['start', '--home', homeB], origin)
  await eventually(() => api(`/workers/${workerIdB}/capabilities`), value => value.capabilities.some(agent => agent.agentKey === 'test' && agent.availability.status === 'available'), 'Worker B Test Agent online')
  const provisionB = await api('/workspaces', 'POST', { projectId: project.id, workerId: workerIdB, name: 'Attachment Workspace B', source: 'empty', requestId: randomUUID() })
  await eventually(() => api(`/workspaces/${provisionB.workspace.id}`), space => space.placements.some(placement => placement.workerId === workerIdB && placement.status === 'ready'), 'ready placement on Worker B')
  const rebuild = await upload({ ...intent, requestId: randomUUID(), workspaceId: provisionB.workspace.id, workerId: workerIdB }, { name: '笔记.txt', bytes })
  assert.equal(rebuild.status, 201, JSON.stringify(rebuild.data))
  assert.equal(rebuild.data.created, true, '失败后同文件新请求重传畅通，不被 409 挡死')
  assert.notEqual(rebuild.data.session.id, session.id, '重建创建新会话，不复活失败会话')
  assert.equal(rebuild.data.attachment.sha256, sha256, '同文件内容寻址复用')
  await eventually(() => api(`/teams/default-team/coordination/attachments/${rebuild.data.attachment.id}`), value => value.attachment.delivery.state === 'delivered', 'rebuilt attachment delivered on Worker B')
  const onDiskB = await findWorkspaceFile(join(homeB, 'workspaces'), rebuild.data.attachment.subpath)
  assert.equal(digestOf(await readFile(onDiskB)), sha256, '重传落盘仍是原字节')
  const failedStill = await api(`/teams/default-team/coordination/attachments/${second.data.attachment.id}`)
  assert.equal(failedStill.attachment.delivery.state, 'failed', '失败历史保留，不被重传改写')
  assert.match(failedStill.attachment.delivery.detail ?? '', /撤销/, '失败原因可见，支撑 UI 引导')

  await stat(database)
  console.log(JSON.stringify({
    status: 'pass',
    checks: [
      'Test Agent 如实上报附件能力',
      '阶段一：离线时有界收件 + Task/Session 原子绑定 + 待投递如实呈现',
      '同一意图幂等重放与冲突拒绝',
      '阶段二：Worker 重启后按依赖顺序投递原字节到工作区',
      'Agent read-file 实际读取原字节并回显 sha256/size',
      '撤权：在途投递失败、新上传拒绝、已投递事实不被改写',
      '失败后的用户路径：失败意图重放只回放失败记录；同文件新请求换节点重传端到端成功且失败历史保留',
    ],
    attachment: { id: first.data.attachment.id, subpath, sha256, size: bytes.length, deliveredFile: onDisk },
    rebuilt: { attachmentId: rebuild.data.attachment.id, deliveredFile: onDiskB },
  }))
} catch (error) {
  console.error(`Attachment e2e ${step}: ${error.stack ?? error}; Worker: ${JSON.stringify(worker?.logs())}`)
  process.exitCode = 1
} finally {
  if (worker) {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGTERM')
    const timer = setTimeout(() => worker.child.kill('SIGKILL'), 10000)
    try { const stopped = await worker.done; assert.equal(stopped.code, 0, 'Worker graceful stop') }
    catch (error) { console.error(`Worker shutdown: ${error}`); process.exitCode = 1 }
    finally { clearTimeout(timer) }
  }
  await app.close()
  await removeOwnedServerDatabases(database)
  await rm(directory, { recursive: true, force: true })
}
