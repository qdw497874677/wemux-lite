#!/usr/bin/env node
/**
 * 票05 / 02-05：协调身份写入通道复核探针（D-06）。
 *
 * 目的：在协调入口处于 02-02 交付的关闭态时，对**全部既有写入通道**逐项取得真实拒绝证据或显式登记缺口，
 * 防止未来开放协调时静默遗漏（D-02：不选风险接受；本脚本不开放任何通道）。
 *
 * 真实部分（无合成 Journal、无持久状态注入、无源码 grep 冒充强制）：
 *  - 真 Server（动态端口，显式 capabilitySecret）+ 真 Worker CLI + 确定性 Test Agent（不调用付费模型）；
 *  - 协调身份 = 02-01 定义的只读 allowedTools（`coordinationQueryOperations`）的已签名能力 Grant，
 *    绑定真实在线 Session 与真实账号代际；服务端的签名校验、账号启用状态、代际与权限判定全部真实执行；
 *  - 协调 Task 行由 02-01 的真实创建路径（`teamCoordinationTask`）产生；
 *  - Worker 帧通道通过 Worker 与 Server 之间的自建 TCP 代理注入真实的 transport v2 volatile 帧
 *    （`fs.request` / `terminal.request` / `command`），并读取 Worker 的真实响应帧与本地库副作用。
 *
 * 三态归档：blocked-with-evidence（真实请求给出拒绝）/ documented-gap（显式缺口 + 责任归属）/
 *          unhandled（既无证据也无登记 = 脚本失败）。
 *
 * 运行：node --import tsx apps/e2e/coordination-write-channel-probes.mjs
 */
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { connect, createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { createWemuxServer } from '../server/src/server.ts'
import { login } from './session.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { ownedWorkerLaunch, removeOwnedServerDatabases } from './owned-worker-fixture.mjs'
import { coordinationQueryOperations, coordinationTaskId, teamCoordinationTask } from '../server/src/application/team-coordination-task.ts'

const WRITE_CHANNEL_CLOSED = 'write_channel_closed: 平台当前未开放文件和终端写入通道。'
const capabilitySecret = `probe-capability-secret-${randomUUID()}`
const work = await mkdtemp(join(tmpdir(), 'wemux-write-channel-probes-'))
const home = join(work, 'worker')
const evidenceDir = resolve('.scratch/web-next-project-agent-platform/evidence/02-05')
const ownerEmail = 'probe-owner@example.test', ownerPassword = 'probe-owner-password-value'
const app = createWemuxServer({ databasePath: join(work, 'server.sqlite'), administratorEmails: [ownerEmail], mail: {}, google: {}, capabilitySecret })
const origin = await app.listen(0)
const serverPort = Number(new URL(origin).port)

// ── 真实链路代理：Worker 只经它连接 Server；反向注入真实 Server→Worker 帧并读取 Worker 响应 ──
const frames = { toWorker: [], toServer: [] }
const links = []
const transport = { epoch: null, nextSeq: 1 }
const readWsFrame = buffer => {
  if (buffer.length < 2) return null
  const masked = Boolean(buffer[1] & 0x80)
  let length = buffer[1] & 0x7f, offset = 2
  if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); offset = 4 }
  else if (length === 127) { if (buffer.length < 10) return null; length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
  const payloadStart = offset + (masked ? 4 : 0), total = payloadStart + length
  return buffer.length < total ? null : { length: total, opcode: buffer[0] & 0x0f, masked, payloadStart, payloadLength: length }
}
const frameText = (slice, frame) => {
  if (frame.opcode !== 0x1) return ''
  const payload = slice.subarray(frame.payloadStart, frame.payloadStart + frame.payloadLength)
  if (!frame.masked) return payload.toString('utf8')
  const key = slice.subarray(frame.payloadStart - 4, frame.payloadStart)
  const plain = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) plain[i] = payload[i] ^ key[i % 4]
  return plain.toString('utf8')
}
const sensitiveKey = /(token|secret|password|cookie|authorization|csrf|hash)/i
/** 入册前redact：证据保留帧结构，凭据本身（如 Server 下发的能力令牌）只留指纹。 */
const redact = (value, depth = 0) => {
  if (depth > 8 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1))
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKey.test(key)) out[key] = typeof item === 'string' ? `<redacted:${createHmac('sha256', 'redaction').update(item).digest('hex').slice(0, 8)}>` : '<redacted>'
    else out[key] = redact(item, depth + 1)
  }
  return out
}
const capture = (direction, text) => {
  if (!text.startsWith('{')) return
  try { const value = JSON.parse(text); if (value && typeof value === 'object') frames[direction].push(redact(value)) } catch { /* 非 JSON 帧 */ }
}
const proxy = createServer(client => {
  const upstream = connect(serverPort, '127.0.0.1')
  const link = { client, upstream, head: Buffer.alloc(0), pending: Buffer.alloc(0), upstreamPending: Buffer.alloc(0), upstreamDrained: false, mode: 'probe' }
  links.push(link)
  client.on('error', () => {}); upstream.on('error', () => {})
  upstream.on('close', () => client.destroy()); client.on('close', () => upstream.destroy())
  const write = (socket, chunk) => { try { if (!socket.destroyed) socket.write(chunk) } catch { /* 链路已拆除 */ } }
  const feedWorkerFrames = buffer => {
    link.pending = Buffer.concat([link.pending, buffer])
    for (;;) {
      const frame = readWsFrame(link.pending)
      if (!frame) break
      const slice = link.pending.subarray(0, frame.length)
      link.pending = link.pending.subarray(frame.length)
      capture('toServer', frameText(slice, frame))
      write(upstream, slice)
    }
  }
  client.on('data', chunk => {
    if (link.mode === 'raw') return write(upstream, chunk)
    if (link.mode === 'probe') {
      link.head = Buffer.concat([link.head, chunk])
      const end = link.head.indexOf('\r\n\r\n')
      if (end === -1) return
      const head = link.head.subarray(0, end + 4), rest = link.head.subarray(end + 4)
      link.head = Buffer.alloc(0)
      link.mode = /upgrade:\s*websocket/i.test(head.toString('latin1')) ? 'ws' : 'raw'
      write(upstream, head)
      if (link.mode === 'raw') return write(upstream, rest)
      if (rest.length) feedWorkerFrames(rest)
      return
    }
    feedWorkerFrames(chunk)
  })
  const trackServerFrames = buffer => {
    link.upstreamPending = Buffer.concat([link.upstreamPending, buffer])
    if (!link.upstreamDrained) {
      // 先排干 Upgrade 响应头（101 Switching Protocols）；把它当帧解析会永久错位。
      const end = link.upstreamPending.indexOf('\r\n\r\n')
      if (end === -1) return
      link.upstreamPending = link.upstreamPending.subarray(end + 4)
      link.upstreamDrained = true
    }
    for (;;) {
      const frame = readWsFrame(link.upstreamPending)
      if (!frame) break
      const slice = link.upstreamPending.subarray(0, frame.length)
      link.upstreamPending = link.upstreamPending.subarray(frame.length)
      const text = frameText(slice, frame)
      if (!text.startsWith('{')) continue
      let value
      try { value = JSON.parse(text) } catch { continue }
      if (value?.frameType === 'transport.hello' && value.authoritativeCursors?.serverToWorker?.deliveryEpoch) {
        // 真实的 Server 出站代际与预期序号来自握手（authoritativeCursors），不是构造值。
        transport.epoch = value.authoritativeCursors.serverToWorker.deliveryEpoch
        transport.nextSeq = (value.authoritativeCursors.serverToWorker.ackThrough ?? 0) + 1
      } else if (value?.frameType === 'data' && value.durability === 'durable' && value.deliveryEpoch === transport.epoch) {
        transport.nextSeq = Math.max(transport.nextSeq, value.directionSeq + 1)
      }
      if (value?.frameType === 'data') frames.toWorker.push(redact(value))
    }
  }
  upstream.on('data', chunk => {
    write(client, chunk)
    trackServerFrames(chunk)
  })
})
await new Promise(ready => proxy.listen(0, '127.0.0.1', ready))
const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`
// Server→Worker 帧不掩码（RFC 6455 服务端角色），长度一律用 126 扩展格式以覆盖命令帧。
const wsServerFrame = value => {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
  return Buffer.concat([header, payload])
}
const injectToWorker = value => {
  const live = links.filter(link => link.mode === 'ws' && !link.client.destroyed)
  assert.ok(live.length > 0, 'no live Worker transport link to inject into')
  const wire = wsServerFrame(value)
  for (const link of live) link.client.write(wire)
  return live.length
}
/** 注入持久帧：消耗当前代际的下一序号（镜像 Server 出站分配），并推进探针侧的序号推演。 */
const injectDurableToWorker = value => {
  const live = links.filter(link => link.mode === 'ws' && !link.client.destroyed)
  assert.ok(live.length > 0, 'no live Worker transport link to inject into')
  const frame = durableFrame(value.lane, value.payload)
  const wire = wsServerFrame(frame)
  for (const link of live) link.client.write(wire)
  transport.nextSeq++
  return { count: live.length, frame }
}
const volatileFrame = (lane, payload) => ({ frameType: 'data', durability: 'volatile', lane, payloadVersion: '1', payload })
const durableFrame = (lane, payload) => {
  assert.ok(transport.epoch, 'the Server transport hello must be observed before durable injection')
  return { frameType: 'data', durability: 'durable', deliveryEpoch: transport.epoch, directionSeq: transport.nextSeq, messageId: `probe-message-${randomUUID()}`, lane, payloadVersion: '1', expiresAt: null, payload }
}

const checks = [], errors = [], rows = [], notes = []
let step = 'setup'
const check = label => checks.push(`${step}: ${label}`)
const fail = message => { throw Error(`assertion failed: ${message}`) }
const eventually = async (read, accept, label, timeout = 30000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await delay(40) }
  throw Error(`Timed out: ${label}`)
}
const openDatabase = path => new DatabaseSync(path, { readOnly: true })
const workerSessionRow = id => {
  const db = openDatabase(join(home, 'worker.sqlite'))
  try { return db.prepare("SELECT body FROM documents WHERE bucket='sessions' AND id=?").get(id) ?? null } finally { db.close() }
}
const fingerprint = value => createHmac('sha256', 'probe').update(String(value)).digest('hex').slice(0, 12)

const raw = async (account, path, init = {}) => {
  const response = await fetch(`${origin}/api${path}`, {
    ...init,
    headers: { cookie: account.cookie, ...(init.method && init.method !== 'GET' ? { 'x-csrf-token': account.csrfToken } : {}), ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
  return { status: response.status, body, errorCode: body?.error?.code ?? body?.code ?? null, errorMessage: body?.error?.message ?? body?.message ?? null }
}
const capabilityCall = async (token, operation, body = {}) => {
  const response = await fetch(`${origin}/api/agent-capabilities/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  const text = await response.text()
  let payload = null
  try { payload = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
  return { status: response.status, body: payload, errorCode: payload?.error?.code ?? payload?.code ?? null, errorMessage: payload?.error?.message ?? payload?.message ?? null }
}
const mintCoordinationToken = claims => {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  return `${payload}.${createHmac('sha256', capabilitySecret).update(payload).digest('base64url')}`
}
/** 每行通道：三态之一；unhandled 视为脚本失败。 */
const channel = (name, identity) => {
  const row = { channel: name, identity, verdict: 'unhandled', evidence: [], gaps: [], conclusion: '' }
  rows.push(row)
  return row
}
const blocked = (row, label, detail) => { row.evidence.push({ label, ...detail }) }
const gap = (row, label, detail) => { row.gaps.push({ label, ...detail }) }
const conclude = (row, verdict, conclusion) => { row.verdict = verdict; row.conclusion = conclusion }

let worker, owner, project, task, session, teamId = 'default-team', workerId, workspaceId
let coordinationId, coordinationToken, fullToken, connectorId
const workerFramesBefore = () => frames.toServer.length

try {
  step = 'fixture: server, owner and Team'
  const ownerAccount = await seedLocalAccount(app.store, { username: ownerEmail, email: ownerEmail, password: ownerPassword, administrator: true })
  owner = await login(origin, ownerEmail, ownerPassword)
  await owner.api('/bootstrap', 'POST', {})
  const ownerId = ownerAccount.id
  check(`real server on ${origin.replace(/:\d+$/, ':PORT')} with declared administrator and Team ${teamId}`)

  step = 'fixture: real Worker through the proxy'
  const enrollment = await owner.api('/enrollment-tokens', 'POST', {})
  const isolated = ownedWorkerLaunch(['register', '--home', home, `--token=${enrollment.token}`, '--name', 'Channel Probe Worker'], proxyOrigin)
  const registration = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...isolated.args], { cwd: process.cwd(), env: isolated.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let registerOut = ''
  registration.stdout.setEncoding('utf8').on('data', chunk => { registerOut += chunk })
  const registered = await new Promise(done => registration.once('close', code => done({ code })))
  assert.equal(registered.code, 0, `isolated Worker registration (${registerOut})`)
  workerId = JSON.parse(registerOut).workerId
  const launchWorker = () => {
    const args = ownedWorkerLaunch(['start', '--home', home, '--name', 'Channel Probe Worker'], proxyOrigin)
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...args.args], { cwd: process.cwd(), env: args.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    const done = new Promise(resolve_ => child.once('close', code => resolve_({ code })))
    void done.catch(() => {})
    return { child, done, logs: () => ({ stdout, stderr }) }
  }
  worker = launchWorker()
  await eventually(() => owner.api(`/workers/${workerId}/capabilities`), value => value.capabilities.some(c => c.agentKey === 'test'), 'Worker Test Agent capability')
  await eventually(() => Promise.resolve(links.some(link => link.mode === 'ws')), Boolean, 'Worker WebSocket link through the proxy')
  const projectBody = await owner.api('/projects', 'POST', { name: '通道复核项目', teamId, requestId: 'probe-project' })
  project = projectBody
  task = await owner.api(`/projects/${project.id}/tasks`, 'POST', { title: '通道复核任务', requestId: 'probe-task' })
  const provision = await owner.api('/workspaces', 'POST', { projectId: project.id, workerId, name: '通道复核工作区', source: 'empty', requestId: 'probe-workspace' })
  workspaceId = provision.workspace.id
  await eventually(() => owner.api(`/workspaces/${workspaceId}`), value => value.placements.some(p => p.workerId === workerId && p.status === 'ready'), 'Worker placement ready')
  const created = await owner.api(`/projects/${project.id}/tasks/${task.id}/sessions`, 'POST', { workerId, agentKey: 'test', modelId: 'test', workspaceId, title: '通道复核会话', requestId: 'probe-session' })
  await eventually(() => owner.api(`/commands/${created.commandId}`), value => value.status === 'accepted', 'Worker accepted the Session')
  await eventually(() => owner.api(`/sessions/${created.session.id}`), value => value.freshness.status === 'synced' && value.freshness.contiguousSeq >= 1, 'Session journal synchronized')
  session = created.session
  check(`real Worker ${workerId} online, Session ${session.id} synchronized before any probe`)

  // 真实完整 Turn Grant（对照组：证明同一入口对非协调身份确实可用）
  const enqueue = await owner.api(`/sessions/${session.id}/messages`, 'POST', { content: '[test-agent:pause-ms=50] probe-control', commandId: 'probe-control-command' })
  const pending = await app.store.commands.getPendingCommand(enqueue.commandId)
  fullToken = pending?.command?.capabilities?.token ?? null
  assert.ok(fullToken, 'a real Turn must issue a full capability grant')
  await eventually(() => owner.api(`/sessions/${session.id}/events?fromSeq=1&limit=200`), value => value.events.some(event => event.payload.kind === 'turn.finished'), 'control Turn finished')

  step = 'fixture: coordination identity (02-01)'
  coordinationId = await app.store.transaction(tx => teamCoordinationTask(tx, { teamId, ownerId, workerId, agentKey: 'test' }, 'probe-coordination'))
  assert.equal(coordinationId, coordinationTaskId({ teamId, ownerId, workerId, agentKey: 'test' }))
  const claims = await app.store.transaction(tx => tx.tasks.get(coordinationId))
  assert.equal(claims?.teamCoordination?.teamId, teamId)
  const full = JSON.parse(Buffer.from(fullToken.split('.')[0], 'base64url').toString('utf8'))
  coordinationToken = mintCoordinationToken({
    id: randomUUID(), sessionId: session.id, turnId: full.turnId, actorAgentId: session.id,
    actorUserId: ownerId, actorAuthVersion: full.actorAuthVersion,
    projectId: project.id, workspaceId, allowedTools: coordinationQueryOperations, allowedConnectorIds: [],
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
  })
  const live = await capabilityCall(coordinationToken, 'session.info', {})
  assert.equal(live.status, 200, `the coordination identity must be a live, server-verified grant (${live.status} ${live.errorMessage})`)
  check(`coordination Task ${coordinationId.slice(0, 20)}… created through the real 02-01 path; coordination grant verified live for reads only`)

  // ───────────────────────── 文件 ─────────────────────────
  step = 'channel: 文件'
  const fileRow = channel('文件', 'owner cookie（最高权限调用方）+ 协调能力 Grant + Worker 直连帧')
  const fsWrite = await raw(owner, `/sessions/${session.id}/fs/write`, { method: 'POST', body: JSON.stringify({ requestId: 'probe-fs-write', subpath: 'probe/denied.txt', base64Content: Buffer.from('probe').toString('base64') }) })
  assert.equal(fsWrite.status, 403, `HTTP fs/write must be closed (${fsWrite.status})`)
  assert.equal(fsWrite.errorCode, 'write_channel_closed')
  blocked(fileRow, 'HTTP POST /api/sessions/:id/fs/write（真实已认证最高权限调用方）', { status: fsWrite.status, code: fsWrite.errorCode })
  const fsCoord = await capabilityCall(coordinationToken, 'session.fs.write', { sessionId: session.id })
  assert.equal(fsCoord.status, 403, `coordination grant must not reach the file tool (${fsCoord.status})`)
  notes.push(`能力端点拒绝已生效（403），但错误码被归一为 ${fsCoord.errorCode}（http/handler.ts:113 只把 CapabilityError 映射到状态码，响应体的 code 落到 internal_error）；不影响拒绝结论，未在本切片改变对外错误码。`)
  blocked(fileRow, '协调 Grant 调 session.fs.write（allowedTools 门）', { status: fsCoord.status, code: fsCoord.errorCode, message: fsCoord.errorMessage })
  const fsFull = await capabilityCall(fullToken, 'session.fs.write', { sessionId: session.id })
  blocked(fileRow, '完整 Turn Grant 调 session.fs.write（服务端能力面不存在该操作）', { status: fsFull.status, code: fsFull.errorCode })
  const fsRequestId = `probe-fs-${Date.now()}`
  const injected = injectToWorker(volatileFrame('realtime', { type: 'fs.request', requestId: fsRequestId, sessionId: session.id, operation: 'write', subpath: 'probe/denied.txt', base64Content: Buffer.from('probe').toString('base64') }))
  const fsReply = await eventually(() => frames.toServer.find(frame => frame?.payload?.requestId === fsRequestId && frame.payload.type === 'fs.response'), Boolean, 'Worker fs.response')
  assert.equal(fsReply.payload.ok, false)
  assert.equal(fsReply.payload.error, WRITE_CHANNEL_CLOSED)
  blocked(fileRow, `Worker 直连帧 fs.request(write)（经真实 transport，注入 ${injected} 条链路）`, { ok: fsReply.payload.ok, error: fsReply.payload.error })
  const fsAdmission = await raw(owner, `/sessions/${session.id}/fs/write`, { method: 'POST', body: JSON.stringify({ requestId: 'probe-fs-write', subpath: 'probe/denied.txt', base64Content: Buffer.from('probe').toString('base64') }) })
  assert.equal(fsAdmission.status, 403, 'repeat write must stay closed')
  conclude(fileRow, 'blocked-with-evidence', '文件写入三面全封：HTTP 路由 403 write_channel_closed（先于资源判定）、能力 Grant 403 forbidden、Worker 帧无条件 write_channel_closed。')
  check(`文件：HTTP ${fsWrite.status}/${fsWrite.errorCode}、Grant ${fsCoord.status}/${fsCoord.errorCode}、Worker 帧 write_channel_closed`)

  // ───────────────────────── 终端 ─────────────────────────
  step = 'channel: 终端'
  const terminalRow = channel('终端', 'owner cookie + 协调 Grant + Worker 直连帧')
  for (const path of [`/sessions/${session.id}/terminal`, `/sessions/${session.id}/terminal/probe-terminal/write`, `/sessions/${session.id}/terminal/probe-terminal/resize`]) {
    const response = await raw(owner, path, { method: 'POST', body: JSON.stringify({ data: 'echo probe', cols: 80, rows: 24 }) })
    assert.equal(response.status, 403, `HTTP ${path} must be closed (${response.status})`)
    assert.equal(response.errorCode, 'write_channel_closed')
    blocked(terminalRow, `HTTP POST /api${path}`, { status: response.status, code: response.errorCode })
  }
  const terminalCoord = await capabilityCall(coordinationToken, 'session.terminal.write', { sessionId: session.id })
  assert.equal(terminalCoord.status, 403)
  blocked(terminalRow, '协调 Grant 调 session.terminal.write（allowedTools 门）', { status: terminalCoord.status, code: terminalCoord.errorCode })
  const terminalRequestId = `probe-terminal-${Date.now()}`
  injectToWorker(volatileFrame('realtime', { type: 'terminal.request', requestId: terminalRequestId, sessionId: session.id, operation: 'create', cols: 80, rows: 24 }))
  const terminalReply = await eventually(() => frames.toServer.find(frame => frame?.payload?.requestId === terminalRequestId && frame.payload.type === 'terminal.response'), Boolean, 'Worker terminal.response')
  assert.equal(terminalReply.payload.ok, false)
  assert.equal(terminalReply.payload.error, WRITE_CHANNEL_CLOSED)
  blocked(terminalRow, 'Worker 直连帧 terminal.request(create)', { ok: terminalReply.payload.ok, error: terminalReply.payload.error })
  conclude(terminalRow, 'blocked-with-evidence', '终端三面全封：HTTP 路由 403 write_channel_closed（含 write/resize）、能力 Grant 403 forbidden、Worker 帧无条件 write_channel_closed，未创建 PTY。')
  check(`终端：HTTP 403、Grant ${terminalCoord.status}/${terminalCoord.errorCode}、Worker 帧 write_channel_closed`)

  // ───────────────────────── 连接器 ─────────────────────────
  step = 'channel: 连接器'
  const connectorRow = channel('连接器', '协调 Grant + 完整 Turn Grant + owner cookie')
  // 连接器定义创建不在本探针范围：mcp.call 的拒绝发生在 allowedTools 门（协调身份）与服务端能力面（完整身份），
  // 两者都先于任何连接器解析，所以真实连接器行不是取得证据的前提。
  connectorId = 'probe-connector'
  const mcpCoord = await capabilityCall(coordinationToken, 'mcp.call', { connectorId, tool: 'probe' })
  assert.equal(mcpCoord.status, 403, `coordination grant must not reach connector invocation (${mcpCoord.status})`)
  blocked(connectorRow, '协调 Grant 调 mcp.call（allowedTools 门）', { status: mcpCoord.status, code: mcpCoord.errorCode, message: mcpCoord.errorMessage })
  const mcpFull = await capabilityCall(fullToken, 'mcp.call', { connectorId, tool: 'probe' })
  assert.equal(mcpFull.status, 404, `the server must expose no connector invocation operation (${mcpFull.status})`)
  blocked(connectorRow, '完整 Turn Grant 调 mcp.call（服务端无该操作）', { status: mcpFull.status, code: mcpFull.errorCode, message: mcpFull.errorMessage })
  const connectorHttp = await raw(owner, `/projects/${project.id}/connectors`, { method: 'GET' })
  assert.equal(connectorHttp.status, 200, 'the owner may read connector metadata')
  blocked(connectorRow, 'owner cookie 读连接器元数据（对照组：只读可见性不受写入通道关闭影响）', { status: connectorHttp.status, control: true })
  const connectorCoordHttp = await fetch(`${origin}/api/projects/${project.id}/connectors/${connectorId}/test`, { method: 'POST', headers: { authorization: `Bearer ${coordinationToken}`, 'content-type': 'application/json' }, body: '{}' })
  assert.ok([401, 403].includes(connectorCoordHttp.status), `a capability token is not a Web credential (${connectorCoordHttp.status})`)
  blocked(connectorRow, '协调 Grant 调 Web 连接器路由（能力令牌不是 Web 凭据）', { status: connectorCoordHttp.status })
  gap(connectorRow, 'Worker 工具执行网关的 authorize() 不校验 allowedTools/binding', { detail: 'apps/worker/src/application/tool-execution-gateway.ts 的鉴权只校验会话与授权来源，协调快照的只读 allowedTools 不会在 Worker 侧形成强制门；当前无活路径（服务端不暴露 mcp.call/http.call 为可执行操作，见上一行证据）', responsibility: '开放协调写通道（或恢复连接器调用能力）前必须先补 Worker 侧 allowedTools/binding 校验并重跑本矩阵' })
  conclude(connectorRow, 'documented-gap', '服务端两段证据表明连接器调用不可达（协调 Grant 403、完整 Grant 404、Web 路由拒绝能力令牌）；Worker 网关缺少 allowedTools 校验属已登记缺口，登记为资格门阻塞项。')
  check(`连接器：协调 Grant ${mcpCoord.status}/${mcpCoord.errorCode}、完整 Grant ${mcpFull.status}、Web 路由 ${connectorCoordHttp.status}、Worker 网关缺口已登记`)

  // ───────────────────────── 外部投递 ─────────────────────────
  step = 'channel: 外部投递'
  const deliveryRow = channel('外部投递', '协调 Grant + 完整 Turn Grant + owner cookie')
  for (const operation of ['outbound.replay', 'channel.send', 'delivery.replay']) {
    const response = await capabilityCall(coordinationToken, operation, { projectId: project.id })
    assert.equal(response.status, 403, `${operation} must not be reachable (${response.status})`)
    blocked(deliveryRow, `协调 Grant 调 ${operation}`, { status: response.status, code: response.errorCode })
  }
  const replayToken = await fetch(`${origin}/api/projects/${project.id}/channel-deliveries/probe-delivery/replay`, { method: 'POST', headers: { authorization: `Bearer ${coordinationToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'probe' }) })
  assert.ok([401, 403, 404].includes(replayToken.status), `the replay route must not accept a capability token (${replayToken.status})`)
  blocked(deliveryRow, '协调 Grant 调 POST /api/projects/:id/channel-deliveries/:id/replay', { status: replayToken.status })
  const replayOwner = await raw(owner, `/projects/${project.id}/channel-deliveries/probe-delivery/replay`, { method: 'POST', body: JSON.stringify({ reason: 'probe', requestId: 'probe-delivery-replay' }) })
  blocked(deliveryRow, 'owner cookie 调同一路由（对照组：投递重放只对真实用户凭据与写权限开放）', { status: replayOwner.status, code: replayOwner.errorCode })
  assert.ok([403, 404].includes(replayOwner.status), `the owner path must still require a real delivery/role (${replayOwner.status} ${replayOwner.errorCode})`)
  conclude(deliveryRow, 'blocked-with-evidence', '外部投递对协调身份完全没有入口：能力面无任何投递操作（403），投递重放路由不接受能力令牌；重放仍只对真实用户凭据 + 写权限开放（对照组返回同一拒绝）。')
  check(`外部投递：协调 Grant 三个操作 403、重放路由 ${replayToken.status}、owner 对照 ${replayOwner.status}`)

  // ───────────────────────── Web API ─────────────────────────
  step = 'channel: Web API'
  const webRow = channel('Web API', 'owner cookie（协调入口关闭态）+ 协调 Grant + 完整 Turn Grant')
  const coordinationEntry = await raw(owner, `/teams/${teamId}/coordination/sessions`, { method: 'POST', body: '{}' })
  assert.equal(coordinationEntry.status, 403)
  assert.equal(coordinationEntry.errorCode, 'coordination_gate_closed')
  blocked(webRow, 'owner cookie 调 POST /api/teams/:teamId/coordination/sessions（02-02 关闭态）', { status: coordinationEntry.status, code: coordinationEntry.errorCode })
  const availability = await raw(owner, `/teams/${teamId}/coordination/availability`)
  assert.equal(availability.status, 200)
  assert.equal(availability.body?.status, 'disabled')
  blocked(webRow, 'GET /api/teams/:teamId/coordination/availability（服务端投影，非 UI 假象）', { status: availability.status, statusField: availability.body?.status, gate: availability.body?.gate, control: true })
  const createCoord = await capabilityCall(coordinationToken, 'task.create', { projectId: project.id, requestId: 'probe-coord-task', title: '不应创建' })
  assert.equal(createCoord.status, 403, `the coordination identity must not create Tasks (${createCoord.status})`)
  blocked(webRow, '协调 Grant 调 task.create（写类操作不在协调 allowedTools）', { status: createCoord.status, code: createCoord.errorCode })
  const createFull = await capabilityCall(fullToken, 'task.create', { projectId: project.id, requestId: 'probe-full-task', title: '完整身份可创建' })
  assert.equal(createFull.status, 200, `control: a full Turn grant must still create Tasks (${createFull.status} ${createFull.errorMessage})`)
  blocked(webRow, '完整 Turn Grant 调 task.create（对照组：同一入口对非协调身份可用）', { status: createFull.status, taskId: String(createFull.body?.task?.id ?? '').slice(0, 18), control: true })
  const coordTaskGet = await capabilityCall(coordinationToken, 'task.get', { projectId: project.id, taskId: coordinationId })
  assert.equal(coordTaskGet.status, 404, `coordination Tasks must stay invisible to project-scoped grants (${coordTaskGet.status})`)
  blocked(webRow, '协调 Grant 调 task.get 读协调 Task（02-03 作用域规则）', { status: coordTaskGet.status, code: coordTaskGet.errorCode })
  const coordTaskCreateHttp = await fetch(`${origin}/api/projects/${project.id}/tasks`, { method: 'POST', headers: { authorization: `Bearer ${coordinationToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: '不应创建', requestId: 'probe-http-task' }) })
  assert.ok([401, 403].includes(coordTaskCreateHttp.status), `Web Task routes must not accept capability tokens (${coordTaskCreateHttp.status})`)
  blocked(webRow, '协调 Grant 调 POST /api/projects/:id/tasks（能力令牌不是 Web 凭据）', { status: coordTaskCreateHttp.status })
  conclude(webRow, 'blocked-with-evidence', '协调入口在服务端关闭（403 coordination_gate_closed，availability 投影 enabled:false）；协调身份无写类工具（task.create 403）、看不到协调 Task（404）、能力令牌不被 Web 路由接受，而同入口对完整 Turn 身份仍可用。')
  check(`Web API：协调入口 ${coordinationEntry.status}/${coordinationEntry.errorCode}、task.create 协调 ${createCoord.status} vs 完整 ${createFull.status}、协调 Task 读取 ${coordTaskGet.status}`)

  // ───────────────────────── Worker 帧（含 05-H 已封部分复核） ─────────────────────────
  step = 'channel: Worker 帧'
  const frameRow = channel('Worker 帧', 'Server→Worker transport v2 直连帧（05-H 已封部分的复核 + 命令帧授权）')
  blocked(frameRow, 'fs.request(write) / terminal.request 复核（05-H 已封部分仍有效）', { fs: WRITE_CHANNEL_CLOSED, terminal: WRITE_CHANNEL_CLOSED })
  const forgedId = `probe-forged-${randomUUID()}`
  const forgedCommandId = `probe-forged-command-${Date.now()}`
  const before = workerFramesBefore()
  const durableInjection = injectDurableToWorker({ lane: 'command', payload: { type: 'command', commandId: forgedCommandId, command: { kind: 'session.create', session: { sessionId: forgedId, binding: { workspaceId, agent: { workerId, agentKey: 'test' }, modelId: 'test' }, storageMode: 'local' } } } })
  const receipt = await eventually(() => frames.toServer.find(frame => frame?.payload?.receipt?.commandId === forgedCommandId), Boolean, 'Worker command receipt')
  assert.equal(receipt.payload.receipt.status, 'accepted', `the Worker must accept the injected command (${receipt.payload.receipt.status})`)
  const forgedRow = await eventually(() => workerSessionRow(forgedId), Boolean, 'forged Session row in the Worker store')
  gap(frameRow, 'Worker 不校验命令帧授权（信任集群连接）', { detail: `注入的 transport v2 **持久命令帧**（lane=command, durability=durable, deliveryEpoch=${durableInjection.frame.deliveryEpoch}, directionSeq=${durableInjection.frame.directionSeq}, commandId ${forgedCommandId}）被 Worker 直接执行：回执 status=${receipt.payload.receipt.status}，并在 Worker 本地库建出 Session 行 ${forgedId}（bucket=sessions）。协调身份的门只在 Server 侧，Worker 侧对任何到达的帧没有 allowedTools/binding 校验`, responsibility: '任何开放协调写通道的设计必须先补 Worker 侧命令帧授权（或保证 Server 侧永不转发越权命令并加审计），并重跑本矩阵', framesObserved: frames.toServer.length - before })
  conclude(frameRow, 'documented-gap', '文件和终端帧的关闭（05-H）在真实帧注入下仍有效；但命令帧缺乏 Worker 侧授权，属已登记缺口，登记为资格门阻塞项。')
  check(`Worker 帧：05-H 关闭复核有效；注入命令帧被接受（回执 ${receipt.payload.receipt.status}，本地 Session ${forgedId.slice(0, 18)}…）并登记为缺口`)

  step = 'hygiene'
  const secrets = [ownerPassword, fullToken, coordinationToken, owner.cookie, owner.csrfToken, capabilitySecret]
  const haystack = `${JSON.stringify(frames)}\n${worker.logs().stdout}\n${worker.logs().stderr}`
  const leaked = secrets.filter(secret => typeof secret === 'string' && secret.length > 8 && haystack.includes(secret))
  if (leaked.length) fail(`credential sentinel hit ${leaked.length} value(s)`)
  const unhandled = rows.filter(row => row.verdict === 'unhandled')
  if (unhandled.length) fail(`unhandled channel: ${unhandled.map(row => row.channel).join(', ')}`)
  const unexpected = rows.flatMap(row => row.evidence).filter(item => item.status === 200 && !item.control)
  if (unexpected.length) fail(`a probe returned 200 without a registered gap: ${JSON.stringify(unexpected)}`)
  check(`${rows.length} channels归档为三态（blocked-with-evidence ${rows.filter(r => r.verdict === 'blocked-with-evidence').length} / documented-gap ${rows.filter(r => r.verdict === 'documented-gap').length} / unhandled 0）；凭据哨兵 ${secrets.filter(s => typeof s === 'string' && s.length > 8).length} 项无泄漏`)

  const evidence = {
    ok: checks.length,
    checks,
    errors,
    notes,
    runtime: 'real Server + real Worker CLI + deterministic Test Agent; no paid model, no synthetic Journal, no injection of durable state, no source-grep claims',
    coordinationIdentity: { taskId: coordinationId, allowedTools: coordinationQueryOperations, grantVerified: 'session.info 200（服务端真实校验签名/账号代际/权限）', redaction: `…${fingerprint(coordinationToken)}` },
    channels: rows,
    boundary: { workerFramesObserved: frames.toServer.length, durableInjected: 1, volatileInjected: frames.toWorker.filter(f => f.frameType === 'data').length, notes },
  }
  await writeFile(join(work, 'result.json'), JSON.stringify(evidence, null, 2))
  await mkdir(evidenceDir, { recursive: true })
  await cp(work, evidenceDir, { recursive: true, force: true })
  console.log(JSON.stringify({ evidence: evidenceDir, checks: checks.length, channels: rows.map(row => ({ channel: row.channel, verdict: row.verdict })) }))
} catch (error) {
  await writeFile(join(work, 'failure.json'), JSON.stringify({ step, message: String(error), stack: String(error?.stack ?? ''), checks, errors, notes, rows, workerLogs: worker?.logs(), frames: { toServer: frames.toServer.slice(-40), toWorker: frames.toWorker.slice(-40) } }, null, 2)).catch(() => {})
  await mkdir(evidenceDir, { recursive: true }).catch(() => {})
  await cp(work, evidenceDir, { recursive: true, force: true }).catch(() => {})
  console.error(`assertion failed at ${step}: ${error.message}`)
  process.exitCode = 1
} finally {
  try { worker?.child.kill('SIGTERM') } catch { /* 已退出 */ }
  for (const link of links.splice(0)) { link.client.destroy(); link.upstream.destroy() }
  proxy.close()
  await app.close()
  await removeOwnedServerDatabases(join(work, 'server.sqlite')).catch(() => {})
  await rm(home, { recursive: true, force: true }).catch(() => {})
}