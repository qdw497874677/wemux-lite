import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket, WebSocketServer } from 'ws'
import type { WorkerId } from '@wemux/domain'
import type { FileRequestPayload, TerminalRequestPayload, WorkerDataFrame } from '@wemux/wire-protocol'
import { createWemuxServer } from '../../server/src/server.ts'
import { SqliteServerStore } from '../../server/src/storage/sqlite/store.ts'
import { ServerTransportStore } from '../../server/src/worker-ws/transport-store.ts'
import { TransportV2Peer } from '../../server/src/test/transport-v2-peer.ts'
import { ownedWorkerLaunch } from '../../e2e/owned-worker-fixture.mjs'
import { provisionAdministrator } from '../../e2e/session.ts'

const closedError = 'write_channel_closed: 平台当前未开放文件和终端写入通道。'
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
async function eventually(check: () => boolean | Promise<boolean>, label: string) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await delay(25) }
  assert.fail(`Timed out: ${label}`)
}

// Loopback-only, transparent HTTP/WS forwarding. Drop controls never rewrite hello cursors.
async function proxy() {
  let upstream = '', dropRequestAck = false, holdResponses = false
  const workerFrames: Array<Record<string, any>> = [], serverFrames: Array<Record<string, any>> = [], dropped: Array<Record<string, any>> = []
  const pairs = new Set<WebSocket>()
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const response = await fetch(upstream + req.url, { method: req.method, headers: req.headers as Record<string, string>,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) })
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()))
    } catch { res.writeHead(502); res.end() }
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, downstream => {
    const target = new WebSocket(upstream.replace('http:', 'ws:') + req.url, { headers: { authorization: req.headers.authorization! } })
    pairs.add(downstream); pairs.add(target)
    const pending: string[] = []
    target.on('open', () => { for (const text of pending) target.send(text); pending.length = 0 })
    downstream.on('message', raw => {
      const text = raw.toString(), frame = JSON.parse(text); workerFrames.push(frame)
      if (dropRequestAck && frame.frameType === 'transport.ack') { dropped.push(frame); return }
      if (holdResponses && frame.frameType === 'data') return
      if (target.readyState === WebSocket.OPEN) target.send(text); else pending.push(text)
    })
    target.on('message', raw => {
      const text = raw.toString(); serverFrames.push(JSON.parse(text))
      if (downstream.readyState === WebSocket.OPEN) downstream.send(text)
    })
    for (const [a, b] of [[target, downstream], [downstream, target]]) {
      a.on('error', () => { a.terminate(); b.terminate() })
      a.on('close', () => { pairs.delete(a); b.terminate() })
    }
  }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert(address && typeof address !== 'string')
  return { origin: `http://127.0.0.1:${address.port}`, workerFrames, serverFrames, dropped,
    target: (origin: string) => { upstream = origin },
    hold: (enabled: boolean) => { dropRequestAck = enabled; holdResponses = enabled },
    async close() { for (const socket of pairs) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

test('real CLI Worker consumes persisted old write frames across Server/home restarts and lost ACK without effects', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-write-replay-')), home = join(directory, 'worker'), databasePath = join(directory, 'server.sqlite')
  const email = 'write-replay@example.com'
  const options = { databasePath, administratorEmails: [email], capabilitySecret: 'local-test-only-secret-32-characters-long', mail: {}, google: {} }
  let app = createWemuxServer(options), transport: ServerTransportStore | undefined
  const bridge = await proxy()
  const children: Array<ReturnType<typeof launch>> = []
  function launch(args: string[]) {
    const config = ownedWorkerLaunch(args, bridge.origin, { ...process.env, PATH: '/usr/bin:/bin', HOME: directory })
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...config.args], { env: config.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
    const entry = { child, done, get stdout() { return stdout }, get stderr() { return stderr } }; children.push(entry); return entry
  }
  async function stop(entry: ReturnType<typeof launch>, signal: NodeJS.Signals = 'SIGTERM') {
    if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill(signal)
    const timer = setTimeout(() => entry.child.kill('SIGKILL'), 5000)
    try { const result = await entry.done; t.diagnostic(JSON.stringify({ pid: entry.child.pid, ...result })); return result }
    finally { clearTimeout(timer) }
  }
  t.after(async () => {
    for (const child of children) await stop(child)
    transport?.close(); await bridge.close(); await app.close()
    const alive = children.filter(({ child }) => { try { process.kill(child.pid!, 0); return true } catch { return false } }).length
    t.diagnostic(`owned child processes remaining=${alive}`); assert.equal(alive, 0)
    await rm(directory, { recursive: true, force: true })
  })
  bridge.target(await app.listen(0))
  const owner = await provisionAdministrator({ store: app.store, baseUrl: bridge.origin, email })
  await owner.api('/bootstrap', 'POST', {})
  const enrollment = await owner.api<{ token: string }>('/enrollment-tokens', 'POST', {})
  const registration = launch(['register', '--home', home, '--token', enrollment.token, '--name', 'Write replay'])
  assert.equal((await registration.done).code, 0, registration.stderr)
  const workerId = JSON.parse(registration.stdout).workerId as WorkerId
  let worker = launch(['start', '--home', home])
  await eventually(async () => (await app.store.resources.getWorker(workerId))?.capabilities?.some(c => c.agentKey === 'test' && c.availability.status === 'available') === true, 'CLI Test Agent capability')
  // Diagnostic opens must not reset the presence owned by the live Server.
  const observer = new SqliteServerStore(databasePath)
  assert.equal((await observer.resources.getWorker(workerId))?.connectionState, 'online'); observer.close()
  assert.equal((await app.store.resources.getWorker(workerId))?.connectionState, 'online')
  const project = await owner.api<{ id: string }>('/projects', 'POST', { name: 'Replay', teamId: 'default-team', requestId: 'replay-project' })
  const task = await owner.api<{ id: string }>(`/projects/${project.id}/tasks`, 'POST', { title: 'Replay', requestId: 'replay-task' })
  const provision = await owner.api<{ workspace: { id: string } }>(`/projects/${project.id}/tasks/${task.id}/workspaces`, 'POST', { name: 'Replay', workerId, source: 'empty', requestId: 'replay-workspace' })
  const workspaceId = provision.workspace.id
  await eventually(async () => (await app.store.resources.getWorkspace(workspaceId as never))?.placements.some(p => p.workerId === workerId && p.status === 'ready') === true, 'ready Placement')
  const created = await owner.api<{ id: string; session?: { id: string } }>(`/projects/${project.id}/tasks/${task.id}/sessions`, 'POST', { title: 'Replay', requestId: 'replay-session', workspaceId, workerId, agentKey: 'test', modelId: 'test' })
  const sessionId = (created.session?.id ?? created.id) as FileRequestPayload['sessionId']
  assert(sessionId, JSON.stringify(created))
  await eventually(async () => (await app.store.commands.listDeliverable(workerId, 100)).length === 0, 'Session creation application receipt')
  const root = (await app.store.resources.getWorkspace(workspaceId as never))!.placements.find(p => p.workerId === workerId)!.location!.rootPath
  const bytes = Buffer.from([0, 255, 128, 13, 10]); await writeFile(join(root, 'existing.bin'), bytes)
  const before = await stat(join(root, 'existing.bin'))
  const unchanged = async () => {
    assert.deepEqual(await readFile(join(root, 'existing.bin')), bytes)
    const after = await stat(join(root, 'existing.bin')); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs)
    assert.deepEqual(await readdir(root), ['existing.bin'])
  }
  await stop(worker)
  await eventually(async () => (await app.store.resources.getWorker(workerId))?.connectionState === 'offline', 'first disconnect')
  transport = new ServerTransportStore(`${databasePath}.transport`)
  const read = (requestId: string): FileRequestPayload => ({ type: 'fs.request', requestId, sessionId, operation: 'read', subpath: 'existing.bin', maxBytes: 1024 })
  const writes: Array<FileRequestPayload | TerminalRequestPayload> = [
    { type: 'fs.request', requestId: 'old-file', sessionId, operation: 'write', subpath: 'existing.bin', base64Content: 'bmV3' },
    { type: 'fs.request', requestId: 'old-new-file', sessionId, operation: 'write', subpath: 'new/nested.bin', base64Content: 'bmV3' },
    { type: 'terminal.request', requestId: 'old-create', sessionId, operation: 'create', cols: 80, rows: 24 },
    { type: 'terminal.request', requestId: 'old-write', sessionId, operation: 'write', terminalId: 'old-terminal', data: 'touch marker\r' },
    { type: 'terminal.request', requestId: 'old-resize', sessionId, operation: 'resize', terminalId: 'old-terminal', cols: 120, rows: 40 },
    { type: 'terminal.request', requestId: 'old-dispose', sessionId, operation: 'dispose', terminalId: 'old-terminal' },
  ]
  assert.deepEqual(transport.pending(workerId, 64), [])
  for (const request of [read('prefix'), ...writes, read('suffix')]) transport.enqueue(workerId, request)
  const originals = transport.pending(workerId, 64)
  transport.close(); transport = undefined; await app.close()
  app = createWemuxServer(options); bridge.target(await app.listen(0)); transport = new ServerTransportStore(`${databasePath}.transport`)
  assert.deepEqual(transport.pending(workerId, 64), originals)
  const db = new DatabaseSync(`${databasePath}.transport`); t.after(() => db.close())
  const meta = (key: string) => db.prepare('SELECT value FROM transport_meta WHERE worker_id=? AND key=?').get(workerId, key)!.value
  const epoch = originals[0]!.deliveryEpoch, last = originals.at(-1)!.directionSeq
  const response = (id: string) => bridge.workerFrames.find(f => f.frameType === 'data' && f.payload?.requestId === id)?.payload
  worker = launch(['start', '--home', home])
  await eventually(() => !!response('suffix'), 'read after old writes')
  for (const request of writes) assert.deepEqual(response(request.requestId), { type: request.type === 'fs.request' ? 'fs.response' : 'terminal.response', requestId: request.requestId, ok: false, error: closedError })
  for (const id of ['prefix', 'suffix']) { assert.equal(response(id).ok, true); assert.deepEqual(Buffer.from(response(id).base64Content, 'base64'), bytes) }
  await unchanged()
  for (const original of originals) assert(bridge.serverFrames.some(frame => JSON.stringify(frame) === JSON.stringify(original)), `original frame ${original.directionSeq}`)
  await eventually(() => transport!.pending(workerId, 64).length === 0, 'Server outbox drained')
  // Real startup may append resource reconciliation; it is an application event, not ACK-only work.
  const high = Number(meta(`outbound_last_seq:${epoch}`))
  assert.equal(Number(meta(`outbound_ack:${epoch}`)), high)
  const observed = new Map(bridge.serverFrames.filter(f => f.frameType === 'data' && f.directionSeq >= originals[0]!.directionSeq).map(f => [f.directionSeq, f]))
  assert.deepEqual([...observed.keys()].sort((a, b) => a - b), Array.from({ length: high - originals[0]!.directionSeq + 1 }, (_, i) => originals[0]!.directionSeq + i))
  for (const frame of observed.values()) if (frame.directionSeq > last) assert.equal(frame.payload.type, 'resource.set.pull')
  transport.enqueue(workerId, read('new-read'))
  const fresh = transport.pending(workerId, 64)[0]!; assert.equal(fresh.directionSeq, high + 1); assert.equal(fresh.deliveryEpoch, epoch)
  // A reconnect wakes the durable queue without constructing a replacement request.
  await stop(worker); worker = launch(['start', '--home', home])
  await eventually(() => response('new-read')?.ok === true, 'fresh read after second restart')
  await eventually(() => transport!.pending(workerId, 64).length === 0, 'fresh read ACK')
  await unchanged()
  await stop(worker)
  // Commit one old write while withholding its ACK and response from Server, then crash.
  bridge.hold(true)
  transport.enqueue(workerId, { ...writes[0]!, requestId: 'lost-ack' })
  const lost = transport.pending(workerId, 64)[0]!
  worker = launch(['start', '--home', home])
  await eventually(() => !!response('lost-ack'), 'durable refusal before crash')
  const refusal = bridge.workerFrames.find(f => f.frameType === 'data' && f.payload?.requestId === 'lost-ack') as WorkerDataFrame
  assert.deepEqual(transport.pending(workerId, 64).find(frame => frame.messageId === lost.messageId), lost)
  assert(bridge.dropped.some(frame => frame.deliveryEpoch === epoch && frame.ackThrough === lost.directionSeq))
  await unchanged(); await stop(worker, 'SIGKILL')
  const workerDb = new DatabaseSync(join(home, 'transport.sqlite'))
  assert(workerDb.prepare('SELECT 1 FROM transport_inbox WHERE message_id=? AND seq=?').get(lost.messageId, lost.directionSeq))
  assert(workerDb.prepare('SELECT 1 FROM transport_outbox WHERE message_id=? AND seq=?').get(refusal.messageId, refusal.directionSeq)); workerDb.close()
  bridge.hold(false)
  worker = launch(['start', '--home', home])
  await eventually(() => bridge.workerFrames.filter(f => f.frameType === 'data' && f.messageId === refusal.messageId).length >= 2, 'same durable response replay')
  await eventually(() => transport!.pending(workerId, 64).length === 0, 'honest reconnect cursor absorbs lost request ACK')
  const replayed = bridge.workerFrames.filter(f => f.frameType === 'data' && f.messageId === refusal.messageId)
  for (const frame of replayed) assert.deepEqual(frame, refusal)
  assert.equal(Number(meta(`outbound_ack:${epoch}`)), Number(meta(`outbound_last_seq:${epoch}`)))
  const crashHigh = Number(meta(`outbound_last_seq:${epoch}`))
  transport.enqueue(workerId, read('after-crash'))
  const afterCrash = transport.pending(workerId, 64)[0]!; assert.equal(afterCrash.directionSeq, crashHigh + 1); assert.equal(afterCrash.deliveryEpoch, epoch)
  await stop(worker); worker = launch(['start', '--home', home])
  await eventually(() => response('after-crash')?.ok === true, 'read after crash recovery')
  await eventually(() => transport!.pending(workerId, 64).length === 0, 'final Server outbox drain')
  await stop(worker); await unchanged()
  const finalDb = new DatabaseSync(join(home, 'transport.sqlite'))
  assert.equal(finalDb.prepare('SELECT count(*) AS n FROM transport_outbox').get()!.n, 0)
  finalDb.close()
  // Isolate ACK-only behavior from Runtime heads: a controlled peer retains the application receipt.
  const credential = await readFile(join(home, 'credential'), 'utf8')
  const commandId = 'ack-only-command' as never
  await app.store.transaction(tx => tx.commands.insertPending({ commandId, workerId, command: { kind: 'session.cancel', sessionId }, payloadFingerprint: 'ack-only', createdAt: new Date().toISOString() as never }))
  const connectPeer = async () => {
    const ws = new WebSocket(bridge.origin.replace('http:', 'ws:') + '/worker/ws', { headers: { Authorization: `Bearer ${credential}` } })
    const peer = new TransportV2Peer(ws, workerId); await peer.connect({ name: 'ACK-only observer' }); return peer
  }
  let peer = await connectPeer()
  try {
    await peer.wait(payload => payload.type === 'command' && payload.commandId === commandId)
    await eventually(() => transport!.pending(workerId, 64).length === 0, 'controlled command transport ACK')
    const high = Number(meta(`outbound_last_seq:${epoch}`))
    for (let i = 0; i < 20; i++) peer.raw({ frameType: 'transport.ack', deliveryEpoch: epoch, ackThrough: high })
    await delay(100)
    assert.equal(Number(meta(`outbound_last_seq:${epoch}`)), high)
    assert.equal((await app.store.commands.listDeliverable(workerId, 100)).some(c => c.commandId === commandId), true)
    await peer.close(); peer = await connectPeer()
    await peer.wait(payload => payload.type === 'command' && payload.commandId === commandId)
    assert.equal(Number(meta(`outbound_last_seq:${epoch}`)), high + 1)
    t.diagnostic(JSON.stringify({ originalFrames: originals.map(({ messageId, directionSeq, deliveryEpoch }) => ({ messageId, directionSeq, deliveryEpoch })), lostAck: lost.directionSeq, responseReplay: refusal.messageId, finalRead: afterCrash.directionSeq, ackOnlyHigh: high, reconnectHigh: high + 1, handshakes: bridge.serverFrames.filter(f => f.frameType === 'transport.hello').length }))
  } finally { await peer.close() }
})
