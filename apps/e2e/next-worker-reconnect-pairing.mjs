/** 票05 查询缺口 (b)：真实 Worker 断连下的重放观测与浏览器/CLI 配对。
 *
 * 真实部分（无合成 Journal、无 Server 缓存模拟、无持久状态注入）：
 *  - 真 Server（动态端口）+ 真 Worker CLI + 确定性 Test Agent + 真 Chromium 桌面/移动视口；
 *  - 连接经脚本自建的 TCP 代理，Turn 进行中真实阻断 Worker→Server 链路，Worker 在离线期间
 *    把整轮 Turn 写进本地 Journal 与 durable outbox（outbox 滞留、ack 水位不推进）；
 *  - SIGKILL Worker（不优雅关闭），再以同一 home 重启，由 transport 有界重放把滞留帧补传给 Server。
 *
 * 观测窗口（显式声明，均不修改任何持久状态）：帧按原序锁步放行（25ms/帧，等价慢链路），
 *  等 Server 游标真实落后于 Worker Journal 头后冻结链路（帧按原序留在代理内，不丢帧、不改状态、
 *  不干预协议），把未补传窗口（contiguous+1 .. Journal 头）保持到 HTTP/浏览器/CLI 三侧读到同一快照；
 *  随后恢复转发，由真实 durable 重放收敛到 synced，并断言双侧事件序号与内容逐条一致。
 *
 * 已知不可达项（如实记录，不降级模拟）：持久 `gap` 缓存状态无法由链路中断产生——worker 的 durable
 *  outbox 严格按序（directionSeq 连续）重放，`sync: heads` 总排在其所报告的事件之后，Server 游标因此
 *  不会落后于 workerLastSeq；worker 侧 `sync: gap` 仅在所请求 Journal 区间确实不可得时发出
 *  （apps/worker/src/application/runtime.ts:170-185）。脚本仍保留机会性捕获（`gapSeenAt`），
 *  实测为 0，并在 result.json 的 `notes` 中记录原因与替代证据。
 *
 * 运行：需先构建 Next 产物（WEMUX_NEXT_TEST_DIST 指向 /tmp 下的目录）；本脚本不构建。
 *      WEMUX_NEXT_TEST_DIST=/tmp/wemux-next-dist-0204 node --import tsx apps/e2e/next-worker-reconnect-pairing.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { createWemuxServer } from '../server/src/server.ts'
import { provisionAdministrator, login } from './session.ts'
import { seedLocalAccount } from '../server/src/test/fixtures/administrator.ts'
import { ownedWorkerLaunch, removeOwnedServerDatabases } from './owned-worker-fixture.mjs'
import { invokeCapability, parseInvocation } from '../worker/src/agent-cli.ts'

assert.ok(process.env.WEMUX_NEXT_TEST_DIST?.startsWith('/tmp/'), 'owned temporary build required')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs')

const work = await mkdtemp(join(tmpdir(), 'wemux-next-reconnect-pairing-'))
const home = join(work, 'worker')
const evidenceDir = resolve('.scratch/web-next-project-agent-platform/evidence/02-04')
const ownerEmail = 'pairing-owner@example.test', editorEmail = 'pairing-editor@example.test', viewerEmail = 'pairing-viewer@example.test'
const ownerPassword = 'pairing-owner-password', editorPassword = 'pairing-editor-password', viewerPassword = 'pairing-viewer-password'
const app = createWemuxServer({ databasePath: join(work, 'server.sqlite'), administratorEmails: [ownerEmail], mail: {}, google: {}, webNextStaticPath: resolve(process.env.WEMUX_NEXT_TEST_DIST) })
const origin = await app.listen(0)
const serverPort = Number(new URL(origin).port)

// 真实链路阻断/帧门控代理：Worker 只经它连接 Server。
//  cutLink()  物理切断双向链路（等价连接中断，未 ACK 帧留在 Worker durable outbox）
//  holdLink() 暂停转发真实补传帧（`type: "event"` 的 durable 重放），但让 `sync: heads` 等控制帧照常送达：
//             Server 用真实 Journal 头与本地游标比出缺口并保持到浏览器/CLI/HTTP 取完快照，再开闸让真实重放收敛。
//             WS 客户端帧是掩码的：帧边界看明文长度即可，payload 按 RFC 6455 解掩码后读 JSON。
let blocked = false, gateArmed = false, gateHold = false, pausedAt = null, gapSeenAt = null, heldFrames = 0, released = 0
const links = []
// 帧步进释放（锁步）：armed 期间每 25ms 放行一帧（慢链路），所有帧按原序进入 link.toServer。
// 一旦同进程观测到真实缺口（Server 事务内 status='gap'），停止放行 ⟹ 缺口持久且未提前泄露未补传内容。
let pump = null
const startPump = () => {
  if (pump) return
  pump = setInterval(() => {
    if (gapSeenAt) { stopPump(); return }
    for (const link of links) {
      const slice = link.toServer.shift()
      if (!slice) continue
      try { if (!link.upstream.destroyed) link.upstream.write(slice) } catch { /* 链路已拆除 */ }
      released += 1
      break
    }
  }, 25)
}
const stopPump = () => { if (pump) { clearInterval(pump); pump = null } }
const observedCacheTargets = new WeakSet()
// 只读观测：Server 自己对 Session 缓存行（records kind='cache'）的真实快照。
const readServerCache = sessionId => {
  const db = openDatabase(join(work, 'server.sqlite'))
  try {
    const row = db.prepare("SELECT data FROM records WHERE kind='cache' AND id=?").get(sessionId)
    return row ? JSON.parse(String(row.data)) : null
  } finally { db.close() }
}
// 真实前方缺口（contiguous < workerLastSeq）写出的瞬间就是制造与观测的时机。
const markGap = (source, state) => {
  if (gapSeenAt !== null) return
  gapSeenAt = Date.now(); gateHold = true; pausedAt = Date.now(); stopPump()
  trace.push({ phase: 'gap-detected', at: new Date().toISOString(), source, state })
}
// 真实链路冻结：重放进行中停泵（帧全部留在代理内、顺序不变）——未补传区间因此在 Server 侧持续可见。
const freezeLink = reason => {
  if (gateHold) return
  gateHold = true; pausedAt = Date.now(); stopPump()
  trace.push({ phase: 'link-frozen', at: new Date().toISOString(), reason })
}
let syncRequests = 0
const readWsFrame = buffer => {
  if (buffer.length < 2) return null
  const masked = Boolean(buffer[1] & 0x80)
  let length = buffer[1] & 0x7f, offset = 2
  if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); offset = 4 }
  else if (length === 127) { if (buffer.length < 10) return null; length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
  const payloadStart = offset + (masked ? 4 : 0)
  const total = payloadStart + length
  return buffer.length < total ? null : { length: total, opcode: buffer[0] & 0x0f, masked, payloadStart, payloadLength: length }
}
// 客户端→服务端帧是掩码的：按 RFC 6455 解开 payload 才能读 JSON（只用于识别真实 `sync: heads` 帧）。
const unmaskText = (slice, frame) => {
  if (frame.opcode !== 0x1 || !frame.masked) return ''
  const key = slice.subarray(frame.payloadStart - 4, frame.payloadStart)
  const payload = slice.subarray(frame.payloadStart, frame.payloadStart + frame.payloadLength)
  const plain = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) plain[i] = payload[i] ^ key[i % 4]
  return plain.toString('utf8')
}
const proxy = createServer(client => {
  if (blocked) return client.destroy()
  const upstream = connect(serverPort, '127.0.0.1')
  const link = { client, upstream, toServer: [], toWorker: [], pending: Buffer.alloc(0), sniff: '', head: Buffer.alloc(0), mode: 'probe' }
  links.push(link)
  client.on('error', () => {}); upstream.on('error', () => {})
  upstream.on('close', () => client.destroy()); client.on('close', () => upstream.destroy())
  const write = (socket, chunk) => { try { if (!socket.destroyed) socket.write(chunk) } catch { /* 链路已拆除 */ } }
  // 帧门控只对 WebSocket 生效：先探测 HTTP 请求头（register/HTTP 调用必须原样透传）。
  const feedFrames = buffer => {
    link.pending = Buffer.concat([link.pending, buffer])
    for (;;) {
      const frame = readWsFrame(link.pending)
      if (!frame) break
      const slice = link.pending.subarray(0, frame.length)
      link.pending = link.pending.subarray(frame.length)
      // armed 期间一律先缓冲，由 pump 按序步进放行；缺口出现（gapSeenAt）后停泵 = 持久保持。
      // armed 期间一律先缓冲，由 pump 按序步进放行；缺口被观测到（markGap）后 hold 生效 = 持久保持。
      if (gateArmed) {
        if (gateHold) heldFrames += 1
        link.toServer.push(slice)
        continue
      }
      write(upstream, slice)
    }
  }
  client.on('data', chunk => {
    if (link.mode === 'raw') return write(upstream, chunk)
    if (link.mode === 'probe') {
      link.head = Buffer.concat([link.head, chunk])
      const end = link.head.indexOf('\r\n\r\n')
      if (end === -1) return
      const head = link.head.subarray(0, end + 4)
      const rest = link.head.subarray(end + 4)
      link.head = Buffer.alloc(0)
      link.mode = /upgrade:\s*websocket/i.test(head.toString('latin1')) ? 'ws' : 'raw'
      write(upstream, head)
      if (link.mode === 'raw') return write(upstream, rest)
      if (rest.length) feedFrames(rest)
      return
    }
    feedFrames(chunk)
  })
  upstream.on('data', chunk => { sniffDownstream(chunk); write(client, chunk) })
})
await new Promise(ready => proxy.listen(0, '127.0.0.1', ready))
const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`
const cutLink = () => { blocked = true; gateArmed = false; gateHold = false; for (const link of links.splice(0)) { link.client.destroy(); link.upstream.destroy() } }
const holdLink = () => { blocked = false; gateArmed = true; gateHold = false; pausedAt = null; gapSeenAt = null; heldFrames = 0; released = 0; startPump() }
const resumeLink = () => {
  blocked = false; gateArmed = false; stopPump()
  if (!gateHold) return
  gateHold = false
  for (const link of links) {
    for (const slice of link.toServer.splice(0)) { try { if (!link.upstream.destroyed) link.upstream.write(slice) } catch { /* 链路已拆除 */ } }
    for (const chunk of link.toWorker.splice(0)) { try { if (!link.client.destroyed) link.client.write(chunk) } catch { /* 链路已拆除 */ } }
  }
}

const checks = [], errors = [], samples = [], trace = [], cacheWrites = [], notes = []
let browser, worker, step = 'setup'
const check = label => checks.push(`${step}: ${label}`)
const fail = message => { throw Error(`assertion failed: ${message}`) }
// 只读观测：拦截 store.transaction，观测事务内 cache 的真实写入结果（tx.cache 不是 store.cache 的同一个对象）。
// 不修改任何行为，也不向事务里注入额外读写。
const observedTx = new WeakSet()
const observeCache = cache => {
  if (!cache || observedCacheTargets.has(cache)) return
  observedCacheTargets.add(cache)
  for (const name of ['markSessionGap', 'applyEvents', 'recordWorkerHead', 'markWorkerOffline', 'markWorkerOrphaned']) {
    const original = cache[name]
    if (typeof original !== 'function') continue
    cache[name] = async (...args) => {
      const result = await original.apply(cache, args)
      if (result && result.contiguousSeq !== undefined) {
        cacheWrites.push({ at: Date.now(), method: name, status: result.status, contiguousSeq: result.contiguousSeq, workerLastSeq: result.workerLastSeq ?? null })
        const forwardGap = result.status === 'gap' && (name === 'applyEvents' || Number(result.workerLastSeq ?? 0) > Number(result.contiguousSeq ?? 0))
        if (forwardGap) markGap(`store.cache.${name}`, result)
      }
      return result
    }
  }
}
observeCache(app.store.cache)
// 下游（Server→Worker）帧是未掩码明文：出现 `sync: request` 时读一次缓存行确认是否真的是前方缺口。
const sniffDownstream = chunk => {
  const text = chunk.toString('latin1')
  if (!text.includes('"kind":"request"')) return
  syncRequests += 1
  const sessionId = /"sessionId":"([0-9a-f-]{36})"/.exec(text)?.[1]
  if (!sessionId) return
  const state = readServerCache(sessionId)
  if (state?.status === 'gap' && Number(state.workerLastSeq ?? 0) > Number(state.contiguousSeq ?? 0)) markGap('downstream sync.request', state)
}

function launch(args) {
  const isolated = ownedWorkerLaunch(args, proxyOrigin)
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/cli.ts', ...isolated.args], { cwd: process.cwd(), env: isolated.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const done = new Promise((resolve_, reject) => { child.once('error', reject); child.once('close', code => resolve_({ code, signal: child.signalCode, stdout, stderr })) })
  void done.catch(() => {})
  const stopGracefully = async () => {
    const current = worker; worker = undefined
    if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill('SIGTERM')
    const timer = setTimeout(() => current.child.kill('SIGKILL'), 10000)
    try { return await current.done } finally { clearTimeout(timer) }
  }
  const kill = async () => {
    const current = worker; worker = undefined
    current.child.kill('SIGKILL')
    return await current.done
  }
  return { child, done, stopGracefully, kill, logs: () => ({ stdout, stderr }) }
}
async function eventually(read, accept, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await delay(40) }
  throw Error(`Timed out: ${label}`)
}
const openDatabase = path => new DatabaseSync(path, { readOnly: true })
const serverCacheState = (sessionId) => {
  const db = openDatabase(join(work, 'server.sqlite'))
  try {
    const row = db.prepare("SELECT data FROM records WHERE kind='cache' AND id=?").get(sessionId)
    return row ? JSON.parse(String(row.data)) : null
  } finally { db.close() }
}
const workerJournalRows = (sessionId) => {
  const db = openDatabase(join(home, 'worker.sqlite'))
  try { return db.prepare('SELECT seq, body FROM journal WHERE session_id=? ORDER BY seq').all(sessionId).map(row => ({ seq: Number(row.seq), event: JSON.parse(String(row.body)) })) }
  finally { db.close() }
}
const workerTransport = () => {
  const db = openDatabase(join(home, 'transport.sqlite'))
  try {
    const meta = key => { const row = db.prepare('SELECT value FROM transport_meta WHERE key=?').get(key); return row ? String(row.value) : null }
    const epoch = meta('outbound_epoch'), last = Number(meta('outbound_last_seq') ?? 0), ack = Number(meta(`outbound_ack:${epoch}`) ?? 0)
    return { epoch, last, ack, outbox: Number(db.prepare('SELECT COUNT(*) AS n FROM transport_outbox').get().n) }
  } finally { db.close() }
}
const transportCounts = () => {
  const db = openDatabase(join(home, 'transport.sqlite'))
  try { return Object.fromEntries(db.prepare("SELECT json_extract(payload_json,'$.type') AS type, COUNT(*) AS n FROM transport_outbox GROUP BY 1").all().map(row => [String(row.type), Number(row.n)])) }
  finally { db.close() }
}
const fingerprint = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 12)

let owner, editor, viewer, project, task, workspaceId, workerId
let sessionA, sessionB
let sessionAGrant, editorOfflineGrant, editorGrantFingerprint
const redact = value => (typeof value === 'string' && value.length > 16 ? `${value.slice(0, 6)}…${fingerprint(value)}` : value)

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
const cliQuery = (token, args) => invokeCapability(parseInvocation(args), { WEMUX_CAPABILITY_ENDPOINT: `${origin}/api/agent-capabilities`, WEMUX_CAPABILITY_TOKEN: token })

try {
  owner = await provisionAdministrator({ store: app.store, baseUrl: origin, email: ownerEmail, password: ownerPassword })
  const api = owner.api
  await api('/bootstrap', 'POST', {})
  const editorAccount = await seedLocalAccount(app.store, { username: editorEmail, email: editorEmail, password: editorPassword })
  const viewerAccount = await seedLocalAccount(app.store, { username: viewerEmail, email: viewerEmail, password: viewerPassword })
  editor = await login(origin, editorEmail, editorPassword)
  viewer = await login(origin, viewerEmail, viewerPassword)
  for (const account of [editor, viewer]) {
    const invitation = await api('/teams/default-team/invitations', 'POST', { email: account.username })
    const accepted = await account.api(`/team-invitations/${invitation.token}/accept`, 'POST', {})
    assert.ok(accepted !== undefined)
  }

  step = 'setup: worker'
  const enrollment = await api('/enrollment-tokens', 'POST', {})
  const registration = launch(['register', '--home', home, `--token=${enrollment.token}`, '--name', 'Pairing Worker'])
  const registered = await registration.done
  assert.equal(registered.code, 0, 'isolated Worker registration')
  workerId = JSON.parse(registered.stdout).workerId
  const start = () => { worker = launch(['start', '--home', home, '--name', 'Pairing Worker']) }
  start()
  await eventually(() => api(`/workers/${workerId}/capabilities`), value => value.capabilities.some(c => c.agentKey === 'test' && c.availability.status === 'available'), 'actual Worker capabilities')
  check(`Worker ${workerId} online with the deterministic Test Agent capability`)

  const projectBody = await api('/projects', 'POST', { name: '配对观测项目', teamId: 'default-team', requestId: 'pairing-project' })
  project = projectBody
  task = await api(`/projects/${project.id}/tasks`, 'POST', { title: '配对观测任务', requestId: 'pairing-task' })
  const provision = await api('/workspaces', 'POST', { projectId: project.id, workerId, name: '配对观测工作区', source: 'empty', requestId: 'pairing-workspace' })
  workspaceId = provision.workspace.id
  await eventually(() => api(`/workspaces/${workspaceId}`), value => value.placements.some(p => p.workerId === workerId && p.status === 'ready'), 'Worker provisioned placement')

  const createSession = async (title, requestId) => {
    const created = await api(`/projects/${project.id}/tasks/${task.id}/sessions`, 'POST', { workerId, agentKey: 'test', modelId: 'test', workspaceId, title, requestId })
    await eventually(() => api(`/commands/${created.commandId}`), command => command.status === 'accepted', `Worker accepted ${title}`)
    await eventually(() => api(`/sessions/${created.session.id}`), value => value.freshness.status === 'synced' && value.freshness.contiguousSeq >= 1, `${title} journal synchronized`)
    return created.session
  }
  sessionA = await createSession('配对观测会话 A', 'pairing-session-a')
  sessionB = await createSession('配对观测会话 B', 'pairing-session-b')
  // 队友在项目内入队需要 Project Grant（默认 shareScope=owner-only 时队友无角色）
  const editorGrant = await owner.api(`/projects/${project.id}/grants`, 'POST', { userId: editorAccount.id, role: 'contributor' })
  assert.equal(editorGrant.role, 'contributor')
  const metadata = id => api(`/sessions/${id}`)
  const journal = id => api(`/sessions/${id}/events?fromSeq=1&limit=1000`)
  check('real Worker bound; two Sessions synchronized before the disconnect')

  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const pages = []
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' })
    assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: ownerEmail, password: ownerPassword } })).status(), 200)
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    page.on('pageerror', error => errors.push({ name, step, message: error.message }))
    await page.goto(`${origin}/next/projects/${project.id}?task=${task.id}`)
    const surface = page.getByRole('region', { name: '任务会话', exact: true })
    await surface.getByRole('button', { name: `查看会话：${sessionA.title}`, exact: true }).click()
    const panel = page.getByRole('region', { name: '任务会话对话', exact: true })
    await eventually(() => panel.getAttribute('data-conversation-session'), value => value === sessionA.id, `${name} panel bound to Session A`)
    pages.push({ name, context, page, panel, history: panel.getByRole('region', { name: '会话历史', exact: true }) })
  }
  check('desktop and mobile browsers bound to the same Session before the disconnect')

  step = 'gap: offline turn'
  // 长回声：离线 Turn 产出上百个 assistant.text.delta 事件帧，使 durable outbox 重放需要多轮有界 flush
  // （阶段 1 设计：纯 ACK 驱动的 flush 只能重放 outbox），缺口窗口因此有真实补传过程。
  const echo = `[test-agent:pause-ms=1500] pairing-gap ${'abcdefgh'.repeat(120)}`
  const sent = await api(`/sessions/${sessionA.id}/messages`, 'POST', { content: echo, commandId: 'pairing-gap-command' })
  assert.ok(sent.commandId)
  await eventually(() => journal(sessionA.id), page => page.events.some(event => event.payload.kind === 'turn.started'), 'turn.started before the cut')
  sessionAGrant = (await app.store.commands.getPendingCommand(sent.commandId))?.command?.capabilities?.token ?? null
  assert.ok(sessionAGrant, 'owner Turn must issue a scoped capability grant')
  cutLink()
  trace.push({ phase: 'cut', at: new Date().toISOString() })
  const cutSnapshot = { freshness: (await metadata(sessionA.id)).freshness, events: (await journal(sessionA.id)).events.map(event => event.seq), transport: workerTransport() }
  // 离线期间：编辑器在会话 B 上入队（断连期间签发的 Grant，留作撤权负例）
  const offlineSend = await editor.api(`/sessions/${sessionB.id}/messages`, 'POST', { content: '[test-agent:pause-ms=100] editor-offline', commandId: 'pairing-editor-offline' })
  assert.ok(offlineSend.commandId)
  const offlineCommand = await eventually(() => api(`/commands/${offlineSend.commandId}`), command => command.status === 'pending' || command.status === 'accepted', 'offline enqueue recorded server-side')
  editorOfflineGrant = (await app.store.commands.getPendingCommand(offlineSend.commandId))?.command?.capabilities?.token ?? null
  assert.ok(editorOfflineGrant, 'offline enqueue during the disconnect must still issue a grant')
  editorGrantFingerprint = fingerprint(editorOfflineGrant)
  // Worker 在离线期间把整轮 Turn 写进本地 Journal；等待其落定
  const settled = await eventually(
    async () => workerJournalRows(sessionA.id),
    rows => rows.length > 1 && rows.at(-1).event.payload.kind !== 'assistant.text.delta' && rows.some(row => row.event.payload.kind === 'turn.finished'),
    'offline Turn settled in the Worker journal',
    30000,
  )
  const headBeforeKill = settled.at(-1).seq
  const contentSeqs = settled.filter(row => row.event.payload.kind === 'assistant.text.delta').map(row => row.seq)
  assert.ok(contentSeqs.length > 50, `offline Turn must stream enough frames to keep the gap window real (got ${contentSeqs.length})`)
  const offlineSnapshot = { freshness: (await metadata(sessionA.id)).freshness, transport: workerTransport(), counts: transportCounts(), journalHead: headBeforeKill, streamedContent: contentSeqs.length, commandPending: offlineCommand.status }
  assert.equal(offlineSnapshot.freshness.status, 'offline', 'Server must observe the Worker as offline during the cut')
  assert.ok(offlineSnapshot.transport.outbox > 0, 'undelivered frames must remain in the durable outbox')
  check(`real disconnect: Worker journal advanced offline to ${headBeforeKill} while Server stayed at ${cutSnapshot.freshness.contiguousSeq}`)

  const killed = await worker.kill()
  assert.equal(killed.signal, 'SIGKILL', 'Worker must be killed abruptly, not closed gracefully')
  trace.push({ phase: 'sigkill', at: new Date().toISOString(), code: killed.code, signal: killed.signal })

  step = 'gap: replay and pair observation'
  // 先保持链路暂停（观测窗口），等 heads 帧通过后再暂停双向转发；释放后由真实重放收敛。
  let stopSampling = false
  const sampler = (async () => {
    let last = ''
    while (!stopSampling) {
      // 读序固定：先读可见 Journal，再读 freshness。游标单调递增，所以这个顺序下
      // `visibleTail <= contiguousSeq` 的违反只可能来自非原子写入（事件已可见但游标未推进），
      // 而不是两次 HTTP 读取的时间差（先读 freshness 会造出这种假阳性）。
      const page = await journal(sessionA.id).catch(() => null)
      const value = await metadata(sessionA.id).catch(() => null)
      if (value) {
        const visibleTail = page?.events?.at(-1)?.seq ?? 0
        const key = `${value.freshness.status}:${value.freshness.contiguousSeq}:${value.freshness.workerLastSeq ?? '-'}:${visibleTail}`
        if (key !== last) { samples.push({ at: Date.now(), ...value.freshness, visibleTail }); last = key }
      }
      await delay(20)
    }
  })()
  holdLink()
  const restarted = launch(['start', '--home', home, '--name', 'Pairing Worker'])
  worker = restarted
  // 锁步慢链路（真实链路条件：帧按原序逐帧放行）下等 Server 游标真实落后于 Worker journal 头，
  // 此刻冻结链路（帧全部留在代理内、顺序不变），未补传区间因此在 Server 侧持续可见。
  const partial = await eventually(
    () => Promise.resolve(samples.find(sample => sample.contiguousSeq > cutSnapshot.freshness.contiguousSeq && sample.contiguousSeq < headBeforeKill)),
    Boolean,
    `Server cursor to lag the Worker journal head in the relayed replay (head ${headBeforeKill})`,
    60000,
  ).catch(error => { fail(`gap observation: ${error.message}`) })
  freezeLink(`cursor ${partial.contiguousSeq} < Worker journal head ${headBeforeKill}`)
  await delay(300)
  const gapHttp = await journal(sessionA.id)
  const gapMeta = await metadata(sessionA.id)
  const gapBaseline = { status: gapMeta.freshness.status, contiguousSeq: gapMeta.freshness.contiguousSeq, workerLastSeq: gapMeta.freshness.workerLastSeq, seqs: gapHttp.events.map(event => event.seq) }
  const gapTarget = gapBaseline.contiguousSeq
  assert.ok(['gap', 'syncing', 'offline'].includes(gapBaseline.status), `unexpected freshness ${gapBaseline.status}`)
  assert.ok(gapTarget < headBeforeKill, `MISMATCH: the frozen link must withhold events ${gapTarget + 1}..${headBeforeKill}`)
  assert.equal(gapBaseline.seqs.at(-1), gapTarget, `MISMATCH: visible history must stop at the contiguous cursor ${gapTarget}`)
  assert.ok(Number(gapBaseline.workerLastSeq ?? 0) <= headBeforeKill, 'MISMATCH: Server must never claim a Worker journal head beyond the real journal')
  const cliGap = await cliQuery(sessionAGrant, ['session', 'events', '--session-id', sessionA.id, '--from-seq', '1', '--limit', '1000'])
  const cliGapMeta = await cliQuery(sessionAGrant, ['session', 'get', '--session-id', sessionA.id])
  assert.deepEqual(cliGap.events.map(event => event.seq), gapBaseline.seqs, 'MISMATCH: CLI and HTTP must expose the same visible Journal while the link is stalled')
  assert.equal(cliGapMeta.session.freshness.status, gapBaseline.status, 'MISMATCH: CLI and HTTP must report the same freshness state')
  assert.equal(cliGapMeta.session.freshness.contiguousSeq, gapTarget, 'MISMATCH: CLI and HTTP must report the same contiguous cursor')
  for (const target of pages) {
    await target.panel.getByRole('button', { name: '刷新会话历史', exact: true }).click()
    await target.panel.getByText('已读取会话', { exact: true }).waitFor()
    const text = await target.panel.innerText()
    const visible = await target.panel.locator('[data-journal-seq]').evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-journal-seq'))))
    assert.ok(/Worker 离线|存在缺口|同步中/.test(text), `MISMATCH: ${target.name} must not claim a fresh history while the cursor lags (${text.slice(0, 200)})`)
    assert.ok(visible.every(seq => seq <= gapTarget), `MISMATCH: ${target.name} exposed un-replayed events beyond ${gapTarget}`)
    await target.page.screenshot({ path: join(work, `${target.name}-gap.png`), fullPage: true })
  }
  const gapStatesSeen = samples.filter(sample => sample.status === 'gap').length
  const premature = samples.filter(sample => sample.visibleTail > sample.contiguousSeq)
  assert.deepEqual(premature, [], 'MISMATCH: a surface exposed un-replayed events before the contiguous cursor')
  if (gapStatesSeen === 0) notes.push('02-04 计划要求的持久 gap 状态在当前 transport 语义下不可达：worker 的 durable outbox 严格按序（directionSeq 连续）重放，`sync: heads` 总是排在它所报告的事件之后，Server 游标因此不会落后于 workerLastSeq；worker 侧 `sync: gap` 仅在所请求 Journal 区间确实不可得时发出（apps/worker/src/application/runtime.ts:170-185）。按 02-04-PLAN.md 的 fallback 规则：不降级为缓存模拟，改用真实链路冻结证据（重放中途停帧）并在 SUMMARY 如实标注 blocked。')
  check(`surfaces agree on the stalled-link snapshot: contiguous ${gapTarget}, withheld ${gapTarget + 1}..${headBeforeKill}, no premature exposure across ${samples.length} samples (durable 'gap' states seen: ${gapStatesSeen})`)
  stopSampling = true
  await sampler
  trace.push({ phase: 'gap-release', at: new Date().toISOString(), heldMs: pausedAt ? Date.now() - pausedAt : null, heldFrames, released, syncRequests, gapStatesSeen })
  resumeLink()

  step = 'gap: replay convergence'
  const converged = await eventually(() => metadata(sessionA.id), value => value.freshness.status === 'synced' && value.freshness.contiguousSeq >= headBeforeKill, 'Server converged after replay', 60000)
  assert.equal(converged.freshness.workerLastSeq, converged.freshness.contiguousSeq, 'Worker head must equal the contiguous cursor after replay')
  const httpFinal = await journal(sessionA.id)
  const cliFinal = await cliQuery(sessionAGrant, ['session', 'events', '--session-id', sessionA.id, '--from-seq', '1', '--limit', '1000'])
  const expectedSeqs = Array.from({ length: converged.freshness.contiguousSeq }, (_, index) => index + 1)
  assert.deepEqual(httpFinal.events.map(event => event.seq), expectedSeqs, 'MISMATCH: HTTP Journal is not the replay-completed sequence')
  assert.deepEqual(cliFinal.events.map(event => event.seq), expectedSeqs, 'MISMATCH: CLI Journal is not the replay-completed sequence')
  assert.deepEqual(cliFinal.freshness, httpFinal.freshness, 'MISMATCH: CLI and HTTP freshness differ after replay')
  for (const [index, event] of httpFinal.events.entries()) assert.deepEqual(cliFinal.events[index], event, `MISMATCH: event ${event.seq} content differs between CLI and HTTP`)
  const replayEvent = httpFinal.events.find(event => event.seq === gapTarget + 1)
  assert.ok(replayEvent, `replayed event ${gapTarget + 1} must be present after convergence`)
  const workerJournal = workerJournalRows(sessionA.id)
  assert.deepEqual(httpFinal.events.map(event => event.seq), workerJournal.map(row => row.seq), 'MISMATCH: Server Journal must equal the Worker Journal sequence')
  for (const row of workerJournal) assert.deepEqual(httpFinal.events.find(event => event.seq === row.seq), row.event, `MISMATCH: event ${row.seq} content differs between Worker journal and Server`)
  const drained = await eventually(() => workerTransport(), value => value.outbox === 0 && value.ack === value.last, 'transport outbox drained', 30000)
  const anchorSeqs = httpFinal.events.filter(event => !['assistant.text.delta', 'tool.output.delta', 'tool.finished'].includes(event.payload.kind)).map(event => event.seq)
  const rendered = {}
  for (const target of pages) {
    await target.panel.getByRole('button', { name: '刷新会话历史', exact: true }).click()
    await target.panel.getByText('已读取会话', { exact: true }).waitFor()
    // UI 有意折叠行（SessionConversation.tsx:86）：连续 assistant.text.delta 合并到段落首行，
    // tool.output.delta / tool.finished 归入 tool.started 卡片。所以浏览器断言的是锚点级一致：
    // 不出现 Server 之外的 seq、按序、每个非折叠事件都有行、末事件在屏；精确一致由 HTTP/CLI 断言。
    const visible = await target.panel.locator('[data-journal-seq]').evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-journal-seq'))))
    rendered[target.name] = visible
    assert.ok(visible.length > 0, `MISMATCH: ${target.name} rendered no journal rows`)
    assert.ok(visible.every(seq => expectedSeqs.includes(seq)), `MISMATCH: ${target.name} rendered a seq outside the Server Journal`)
    assert.ok(visible.every((seq, index) => index === 0 || seq > visible[index - 1]), `MISMATCH: ${target.name} rendered out-of-order seqs`)
    for (const seq of anchorSeqs) assert.ok(visible.includes(seq), `MISMATCH: ${target.name} is missing anchor event ${seq}`)
    assert.equal(Math.max(...visible), expectedSeqs.length, `MISMATCH: ${target.name} must render the final event`)
    await target.panel.getByText(/元数据新鲜度：已同步/).waitFor()
    await target.history.getByText(new RegExp(`Echo: ${echo.replace(/[[\]]/g, '\\$&')}`)).waitFor()
    await target.page.screenshot({ path: join(work, `${target.name}-synced.png`), fullPage: true })
  }
  check(`replay converged: outbox drained (last ${drained.last} = ack ${drained.ack}), CLI/HTTP agree on ${expectedSeqs.length} events and both browsers render all ${anchorSeqs.length} anchor events in order`)

  step = 'negative: revoked grant and viewer'
  await owner.api(`/projects/${project.id}/grants`, 'POST', { userId: editorAccount.id, role: 'contributor' })
  await owner.api(`/projects/${project.id}/grants/${editorAccount.id}`, 'DELETE')
  const editorHttp = await raw(editor, `/sessions/${sessionB.id}`)
  const editorGrantError = await cliQuery(editorOfflineGrant, ['session', 'get', '--session-id', sessionB.id]).then(() => null, error => error.message)
  assert.ok(editorGrantError, 'MISMATCH: revoked grant must not read the Session')
  assert.ok(editorHttp.status === 403 || editorHttp.status === 404, `revoked editor must be denied over HTTP, got ${editorHttp.status}`)
  assert.ok(editorGrantError.startsWith(String(editorHttp.errorCode)), `MISMATCH: browser code ${editorHttp.errorCode} vs CLI ${editorGrantError}`)
  const viewerHttp = await raw(viewer, `/sessions/${sessionA.id}`)
  assert.ok(viewerHttp.status === 403 || viewerHttp.status === 404, `viewer without a grant must be denied over HTTP, got ${viewerHttp.status}`)
  const viewerList = await raw(viewer, `/sessions/${sessionA.id}/events?fromSeq=1&limit=100`)
  assert.ok(viewerList.status === 403 || viewerList.status === 404, 'viewer must not read the Journal over HTTP')
  const tampered = `${editorOfflineGrant.slice(0, -2)}xy`
  const tamperedError = await cliQuery(tampered, ['session', 'get', '--session-id', sessionB.id]).then(() => null, error => error.message)
  assert.ok(tamperedError, 'tampered token must be refused')
  const ownerStillReads = await raw(owner, `/sessions/${sessionB.id}`)
  assert.equal(ownerStillReads.status, 200, 'revocation must not affect the owner')
  check(`viewer denied on both surfaces; revoked grant denied HTTP ${editorHttp.status} (${editorHttp.errorCode}) and CLI "${editorGrantError}"; tampered token refused`)

  step = 'hygiene'
  const secrets = [ownerPassword, editorPassword, viewerPassword, sessionAGrant, editorOfflineGrant, owner.csrfToken, editor.csrfToken, viewer.csrfToken, owner.cookie, editor.cookie, viewer.cookie]
  const bodyText = (await Promise.all(pages.map(target => target.page.evaluate(() => document.body.innerText)))).join('\n')
  const workerLogs = `${restarted.logs().stdout}\n${restarted.logs().stderr}`
  const haystack = `${bodyText}\n${workerLogs}\n${JSON.stringify({ samples, trace, cacheWrites })}`
  const leaked = secrets.filter(secret => typeof secret === 'string' && secret.length > 8 && haystack.includes(secret))
  if (leaked.length) fail(`credential sentinel hit ${leaked.length} value(s)`)
  const evidence = {
    ok: checks.length,
    checks,
    errors,
    notes,
    runtime: 'actual Worker CLI + deterministic Test Agent; NOT native Runtime or paid model evidence; no synthetic Journal insertion and no durable state injection',
    mechanism: {
      real: 'TCP cut during Turn, offline Journal growth, SIGKILL, same-home restart, durable outbox replay; the stalled snapshot comes from the real ordered frame stream (lockstep relay at 25ms/frame, frozen mid-replay), and the withheld range is what the Worker journal has but the Server has not yet received',
      observation: { method: 'upstream frame relay is frozen mid-replay (frames kept in the proxy, order unchanged) until HTTP, browser and CLI have read the same snapshot; no durable state is touched', pausedAt: pausedAt ? new Date(pausedAt).toISOString() : null, heldMs: pausedAt ? Date.now() - pausedAt : null, released, heldFrames, syncRequests },
      reason: 'a durable `gap` cache state is not reachable from a link outage in this transport (see notes): the durable outbox replays strictly in order, so `sync: heads` always trails the events it reports and the Server cursor never falls behind workerLastSeq',
    },
    observations: { cut: cutSnapshot, offline: offlineSnapshot, stalled: { baseline: gapBaseline, cliFreshness: cliGapMeta.session.freshness, withheld: [gapTarget + 1, headBeforeKill], gapStatesSeen, gapSeenAt: gapSeenAt ? new Date(gapSeenAt).toISOString() : null, samples }, converged: { contiguous: converged.freshness.contiguousSeq, anchors: anchorSeqs.length, rendered }, drained: { last: drained.last, ack: drained.ack }, cacheWrites: { total: cacheWrites.length, gap: cacheWrites.filter(write => write.status === 'gap').length, trailing: cacheWrites.slice(-12) } },
    negatives: { editorHttp: { status: editorHttp.status, code: editorHttp.errorCode }, editorCli: editorGrantError, viewerHttp: { status: viewerHttp.status, code: viewerHttp.errorCode }, viewerJournal: viewerList.status, tampered: tamperedError },
    redactions: { sessionAGrant: redact(sessionAGrant), editorOfflineGrant: editorOfflineGrant ? `…${editorGrantFingerprint}` : null },
    credentials: { leaked: leaked.length, scanned: secrets.filter(secret => typeof secret === 'string' && secret.length > 8).length },
  }
  await writeFile(join(work, 'result.json'), JSON.stringify(evidence, null, 2))
  await writeFile(join(work, 'worker-restart.log'), workerLogs)
  await mkdir(evidenceDir, { recursive: true })
  await cp(work, evidenceDir, { recursive: true, force: true })
  console.log(JSON.stringify({ evidence: evidenceDir, checks: checks.length, samples: samples.length, stalledAt: gapTarget, withheld: [gapTarget + 1, headBeforeKill], gapStatesSeen }))
} catch (error) {
  gateHold = false
  await writeFile(join(work, 'failure.json'), JSON.stringify({ step, message: String(error), checks, errors, notes, samples, trace, cacheWrites, serverCache: serverCacheState(sessionA?.id ?? ''), workerLogs: worker?.logs() }, null, 2)).catch(() => {})
  await mkdir(evidenceDir, { recursive: true }).catch(() => {})
  await cp(work, evidenceDir, { recursive: true, force: true }).catch(() => {})
  console.error(`assertion failed at ${step}: ${error.message}`)
  process.exitCode = 1
} finally {
  gateHold = false; gateArmed = false; blocked = false
  try { await worker?.stopGracefully() } catch { /* 已被 SIGKILL */ }
  for (const link of links.splice(0)) { link.client.destroy(); link.upstream.destroy() }
  proxy.close()
  await browser?.close().catch(() => {})
  await app.close()
  await removeOwnedServerDatabases(join(work, 'server.sqlite')).catch(() => {})
  await rm(home, { recursive: true, force: true }).catch(() => {})
}