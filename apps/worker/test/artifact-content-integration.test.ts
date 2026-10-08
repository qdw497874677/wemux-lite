import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import type { Artifact } from '@wemux/server-domain'
import type { WorkerPayload } from '@wemux/wire-protocol'
import { createWemuxServer } from '../../server/src/server.ts'
import { administratorEmail, administratorToken, seedOperator } from '../../server/src/test/fixtures/administrator.ts'
import { SqliteArtifactRepository } from '../../server/src/storage/sqlite/artifact-repository.ts'
import { TaskService } from '../../server/src/application/task-service.ts'
import { TransportV2Peer } from '../../server/src/test/transport-v2-peer.ts'
import { WorkerRuntime } from '../src/application/runtime.ts'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.ts'
import { WorkerTransportStore } from '../src/transport/transport-store.ts'
import { WebSocketTransport } from '../src/transport/websocket.ts'
import { MAX_FILE_READ_BYTES, MAX_FS_RESPONSE_PAYLOAD_BYTES } from '../src/files/workspace-files.ts'

const now = () => new Date().toISOString() as never
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-content-integration-'))
  const cleanup: Array<() => void | Promise<void>> = []
  const close = async () => {
    const errors: unknown[] = []
    for (const dispose of cleanup.reverse()) { try { await dispose() } catch (error) { errors.push(error) } }
    await rm(directory, { recursive: true, force: true })
    if (errors.length) throw new AggregateError(errors, 'Artifact integration cleanup failed')
  }
  try {
    const databasePath = join(directory, 'server.sqlite')
    const app = createWemuxServer({ databasePath, administratorEmails: [administratorEmail] }); cleanup.push(() => app.close())
    const operator = await seedOperator(app.store, app.service)
    const base = await app.listen(0)
    assert.notEqual(new URL(base).port, '8004')
    const enrollment = await app.service.createEnrollment({})
    const enrolled = await app.service.enroll({ token: enrollment.token, name: 'artifact-worker' })
    const workerId = enrolled.worker.id
    const task = await new TaskService(app.store).create(operator.project.id, { title: 'Artifact test' }, { actor: operator.userId, requestId: 'artifact-test-task' })
    const sessionId = 'artifact-session' as never
    const binding = { workspaceId: 'artifact-workspace' as never, agent: { workerId, agentKey: 'test-agent' as never }, modelId: null }
    await app.store.transaction(tx => tx.resources.saveSession({ id: sessionId, projectId: operator.project.id, taskId: task.id, runId: null, ownerId: operator.userId, workspaceId: binding.workspaceId, title: 'Artifacts', shareScope: 'project', runtimeState: 'idle', deletedAt: null, binding }))
    // Seed immutable artifact metadata, not the registration/Run workflow under test.
    const repository = new SqliteArtifactRepository(databasePath); cleanup.push(() => repository.close())
    const root = join(directory, 'workspace'); await mkdir(root)
    const store = new SqliteWorkerStore(join(directory, 'worker.sqlite')); cleanup.push(() => store.close())
    const transportStore = new WorkerTransportStore(join(directory, 'worker-transport.sqlite')); cleanup.push(() => transportStore.close())
    store.saveIdentity({ workerId, serverUrl: base, credentialRef: 'test-only', enrolledAt: now() })
    store.saveLocalInstallation({ installationId: 'artifact-installation', name: 'Test', createdAt: now() })
    let transport!: WebSocketTransport
    const responses: WorkerPayload[] = []
    const sends: Promise<void>[] = []
    const runtime = new WorkerRuntime(store, { provision: async () => { throw Error('No provisioning in artifact tests') } }, [], { send: payload => { responses.push(payload); sends.push(transport.send(payload)) } }, workerId, 'Artifacts')
    cleanup.push(() => runtime.shutdown())
    let connected!: () => void
    const ready = new Promise<void>(resolve => { connected = resolve })
    const states: string[] = [], closes: number[] = []
    let connections = 0
    transport = new WebSocketTransport({ url: `${base.replace('http', 'ws')}/worker/ws`, authToken: enrolled.credential, workerId, workerVersion: 'test', name: 'Artifacts', platform: 'linux', architecture: 'x64', store: transportStore, onMessage: payload => runtime.receive(payload), onStateChange: state => { states.push(state.current) }, onConnected: () => {
      connections++
      const socket = (transport as unknown as { socket: WebSocket }).socket
      socket.on('close', code => closes.push(code))
      connected()
    } })
    cleanup.push(async () => {
      const internals = transport as unknown as { socket?: WebSocket; processingMessages: Promise<void> }
      const socket = internals.socket
      const closed = socket && socket.readyState !== WebSocket.CLOSED ? once(socket, 'close') : Promise.resolve()
      transport.stop(); await closed; await internals.processingMessages; await Promise.all(sends)
    })
    await runtime.initialize()
    await store.transaction(async tx => {
      await tx.workspaces.save({ id: binding.workspaceId, workerId, projectId: operator.project.id, rootPath: root, spec: { kind: 'composite', memberWorkspaceIds: [] }, status: 'ready', failureReason: null, updatedAt: now() })
      await tx.sessions.createSession(sessionId, binding)
    })
    transport.start(); await ready
    async function add(name: string, bytes: Buffer | null, size = bytes?.length ?? 0, mimeType = 'application/octet-stream') {
      if (bytes) await writeFile(join(root, name), bytes)
      const artifact: Artifact = { id: name, projectId: operator.project.id, taskId: task.id, runId: 'artifact-run' as never, sessionId, workspaceId: binding.workspaceId, workerId, relativePath: name, mimeType, size, source: 'manual', reviewState: 'pending', revision: 1, createdBy: operator.userId, createdAt: now(), updatedAt: now() }
      await repository.create(artifact, `seed-${name}`, JSON.stringify(artifact), now())
      return `${base}/api/artifacts/${encodeURIComponent(name)}/content`
    }
    const download = (url: string, authenticated = true) => fetch(url, { headers: authenticated ? { authorization: `Bearer ${administratorToken}` } : {}, signal: AbortSignal.timeout(8000) })
    return { close, add, download, root, responses, states, closes, connections: () => connections, base, app, operator }
  } catch (error) { await close(); throw error }
}

for (const [name, bytes, mime] of [
  ['成果.txt', Buffer.from('你好，成果\r\n'), 'text/plain; charset=utf-8'],
  ['bom.txt', Buffer.from('\ufeff成果\r\n'), 'text/plain; charset=utf-8'],
  ['empty.txt', Buffer.alloc(0), 'text/plain'],
  ['binary.bin', Buffer.from([0, 1, 127, 128, 255, 0, 10]), 'application/octet-stream'],
] as const) test(`real Worker artifact HTTP downloads ${name} byte-for-byte`, { timeout: 15000 }, async t => {
  const f = await fixture(); t.after(f.close)
  const url = await f.add(name, bytes, bytes.length, mime)
  const response = await f.download(url)
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  assert.equal(response.headers.get('content-type'), mime)
  assert.equal(response.headers.get('content-length'), String(bytes.length))
  assert.match(response.headers.get('content-disposition')!, /attachment;/)
  assert.ok(response.headers.get('content-disposition')!.includes(`filename*=UTF-8''${encodeURIComponent(name)}`))
  const read = f.responses.find(payload => payload.type === 'fs.response')
  assert.ok(read?.type === 'fs.response' && read.ok && read.operation === 'read')
  if (!read.binary) assert.equal(read.base64Content, undefined)
  t.diagnostic(`Downloaded ${name}: ${bytes.length} exact bytes, MIME ${mime}, real Runtime/SQLite/WebSocket/HTTP`)
})

test('real Worker artifact oversize, missing and unreadable errors are classified without content', { timeout: 20000 }, async t => {
  const f = await fixture(); t.after(f.close)
  assert.equal(MAX_FILE_READ_BYTES, 10 * 1024 * 1024)
  for (const [name, bytes, status, code] of [
    ['oversize.bin', Buffer.alloc(MAX_FILE_READ_BYTES + 1, 0x78), 413, 'artifact_too_large'],
    ['missing.txt', null, 404, 'artifact_not_found'],
    ['directory', null, 422, 'artifact_unreadable'],
  ] as const) {
    if (name === 'directory') await mkdir(join(f.root, name))
    // Deliberately stale size proves the real Worker, not metadata preflight, rejects oversize.
    const response = await f.download(await f.add(name, bytes, 0))
    assert.equal(response.status, status)
    const body = await response.json() as { error: { code: string; message: string } }
    assert.equal(body.error.code, code)
    assert.ok(!JSON.stringify(body).includes(f.root))
    const last = f.responses.filter(payload => payload.type === 'fs.response').at(-1)
    assert.ok(last?.type === 'fs.response' && !last.ok)
    assert.deepEqual(Object.keys(last).sort(), ['error', 'ok', 'requestId', 'type'])
    t.diagnostic(`${name}: HTTP ${status} ${code}, response has error only`)
  }
})

function binaryResponseSize(size: number): number {
  return Buffer.byteLength(JSON.stringify({ type: 'fs.response', requestId: '0'.repeat(36), ok: true, operation: 'read', content: null, base64Content: Buffer.alloc(size).toString('base64'), size, truncated: false, binary: true }))
}

test('real Worker artifact transport boundary rejects before send and keeps the same connection healthy', { timeout: 30000 }, async t => {
  const f = await fixture(); t.after(f.close)
  assert.equal(MAX_FS_RESPONSE_PAYLOAD_BYTES, 4 * 1024 * 1024 - 64 * 1024)
  let boundary = Math.floor(MAX_FS_RESPONSE_PAYLOAD_BYTES / 4) * 3
  while (binaryResponseSize(boundary) > MAX_FS_RESPONSE_PAYLOAD_BYTES) boundary--
  assert.ok(binaryResponseSize(boundary + 1) > MAX_FS_RESPONSE_PAYLOAD_BYTES)
  const bytes = Buffer.alloc(boundary, 0)
  const response = await f.download(await f.add('boundary.bin', bytes))
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  const tooLarge = await f.download(await f.add('boundary-plus-one.bin', Buffer.alloc(boundary + 1)))
  assert.equal(tooLarge.status, 413)
  assert.equal((await tooLarge.json() as { error: { code: string } }).error.code, 'artifact_transport_too_large')
  // Escaped UTF-8 can expand beyond base64; measure JSON rather than guessing from raw size.
  const escaped = await f.download(await f.add('escaped.txt', Buffer.alloc(800000, 1)))
  assert.equal(escaped.status, 413)
  assert.equal((await escaped.json() as { error: { code: string } }).error.code, 'artifact_transport_too_large')
  const healthy = await f.download(await f.add('healthy.txt', Buffer.from('still connected')))
  assert.equal(healthy.status, 200); assert.equal(await healthy.text(), 'still connected')
  assert.equal(f.connections(), 1); assert.deepEqual(f.closes, []); assert.ok(!f.states.includes('backoff'))
  t.diagnostic(`Binary boundary N=${boundary}; serialized payload=${binaryResponseSize(boundary)}; N+1 payload=${binaryResponseSize(boundary + 1)}; cap=${MAX_FS_RESPONSE_PAYLOAD_BYTES}; gateway frame=4194304; same connection remains healthy`)
})

test('artifact HTTP anonymous and hidden Project access do not dispatch Worker reads', { timeout: 15000 }, async t => {
  const f = await fixture(); t.after(f.close)
  const url = await f.add('private.txt', Buffer.from('secret'))
  assert.equal((await f.download(url, false)).status, 401)
  await f.app.store.transaction(tx => tx.resources.saveProject({ ...f.operator.project, ownerId: 'other-owner' as never, shareScope: 'owner-only' }))
  const response = await f.download(url)
  assert.equal(response.status, 404)
  assert.equal((await response.json() as { error: { code: string } }).error.code, 'project_not_found')
  assert.equal(f.responses.filter(payload => payload.type === 'fs.response').length, 0)
})

test('unprotected oversized Worker frame reproduces gateway close 1009', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-frame-probe-'))
  const app = createWemuxServer({ databasePath: join(directory, 'server.sqlite'), administratorEmails: [administratorEmail] })
  let peer: TransportV2Peer | undefined
  try {
    await seedOperator(app.store, app.service)
    const base = await app.listen(0); assert.notEqual(new URL(base).port, '8004')
    const enrollment = await app.service.createEnrollment({})
    const enrolled = await app.service.enroll({ token: enrollment.token, name: 'oversize-probe' })
    const socket = new WebSocket(`${base.replace('http', 'ws')}/worker/ws`, { headers: { authorization: `Bearer ${enrolled.credential}` } })
    peer = new TransportV2Peer(socket, enrolled.worker.id); await peer.connect({ name: 'oversize-probe' })
    const closed = once(socket, 'close')
    // Test-only direct socket probe bypasses Runtime protection to document today's gateway limit.
    socket.send('x'.repeat(4 * 1024 * 1024 + 1))
    const [code] = await closed
    assert.equal(code, 1009)
    t.diagnostic(`Unprotected 4194305-byte frame: Worker socket closes ${code}; production guard prevents this frame`)
  } finally { await peer?.close(); await app.close(); await rm(directory, { recursive: true, force: true }) }
})
