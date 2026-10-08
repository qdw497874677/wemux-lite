import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'
import type { AgentKey, ModelId, SessionId } from '@wemux/domain'
import { createWemuxServer } from '../server.ts'
import { SessionTerminalService } from '../application/session-terminal-service.ts'
import { SessionFileService } from '../application/session-file-service.ts'
import { WorkerService } from '../application/worker-service.ts'
import { sessionRoutes } from '../http/routes/session-routes.ts'
import type { RouteRequestContext } from '../http/routes/types.ts'
import { hashSecret } from '../application/auth.ts'
import { AppError } from '../application/errors.ts'
import { TransportV2Peer } from './transport-v2-peer.ts'
import { effectResponse, sessionEffects } from './fixtures/session-effect-fixture.ts'
import { administratorEmail, administratorToken, instanceOperatorId, seedAdministrator, seedOperator } from './fixtures/administrator.ts'

const closed = { error: { code: 'write_channel_closed', message: '平台当前未开放文件和终端写入通道。' } }
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'wemux-write-closed-'))
  const file = join(root, 'fixture.txt'), path = join(root, 'server.sqlite')
  await writeFile(file, Buffer.from([0, 255, 254, 128, 65, 10]))
  const app = createWemuxServer({ databasePath: path, administratorEmails: [administratorEmail] })
  await seedOperator(app.store, app.service)
  const reader = await seedAdministrator(app.store, { userId: 'write-reader' as never, email: 'reader@example.test', token: 'reader-token' })
  const enrollment = await app.service.createEnrollment({})
  const enrolled = await app.service.enroll({ token: enrollment.token, name: 'write-closed-worker' })
  await app.store.transaction(tx => tx.resources.saveWorker({ ...enrolled.worker, capabilities: [{ agentKey: 'pi' as AgentKey, displayName: 'Pi', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test' as ModelId, displayName: 'Test', source: 'detected' }] }] }))
  const project = await app.service.createProject({ name: 'write-closed-project' })
  const { workspace } = await app.service.createWorkspace({ projectId: project.id, workerId: enrolled.worker.id, name: 'workspace' })
  await app.store.transaction(async tx => {
    const location = { workspaceId: workspace.id, workerId: enrolled.worker.id, rootPath: root, checkouts: [] }
    await tx.resources.saveWorkspace({ ...workspace, status: 'ready', location, placements: workspace.placements.map(p => ({ ...p, status: 'ready', location })) })
    await tx.identity.saveMembership({ teamId: project.teamId, userId: reader.userId, role: 'member', joinedAt: new Date().toISOString() as never })
    await tx.identity.saveProjectGrant({ projectId: project.id, userId: reader.userId, role: 'viewer' })
  })
  const { session } = await app.service.createSession({ requestId: 'write-closed-session', workspaceId: workspace.id, title: 'private-title-sentinel', agentKey: 'pi', modelId: 'test' })
  await app.store.transaction(tx => tx.resources.saveSession({ ...session, shareScope: 'project' }))
  // Fix the volatile HTTP Date in the fixture, not by dropping headers from comparisons.
  app.server.prependListener('request', (_request, response) => response.setHeader('Date', 'Mon, 05 Oct 2026 00:00:00 GMT'))
  const base = await app.listen(0)
  assert.notEqual(new URL(base).port, '8004')
  const socket = new WebSocket(`${base.replace('http', 'ws')}/worker/ws`, { headers: { authorization: `Bearer ${enrolled.credential}` } })
  const peer = new TransportV2Peer(socket, enrolled.worker.id)
  // Real TerminalManager, instrumented in-memory PTY adapter: no OS PTY is claimed.
  const ptys = new Map<number, { cols: number; rows: number; writes: string[]; subscriptions: number }>()
  let spawned = 0
  // Runtime import avoids pulling the Worker source tree into the Server tsc rootDir.
  const { TerminalManager } = await import(new URL('../../../worker/src/terminal/terminal-manager.ts', import.meta.url).href)
  const manager = new TerminalManager({ spawn(_shell: string, _args: readonly string[], options: { cols: number; rows: number }) {
    const pid = ++spawned, state = { cols: options.cols, rows: options.rows, writes: [] as string[], subscriptions: 0 }
    ptys.set(pid, state)
    const subscribe = () => { state.subscriptions++; return { dispose() { state.subscriptions-- } } }
    return { pid, write(data: string) { state.writes.push(data) }, resize(cols: number, rows: number) { state.cols = cols; state.rows = rows }, kill() { ptys.delete(pid) }, onData: subscribe, onExit: subscribe }
  } }, () => {}, () => {}, 1)
  const existing = manager.create({ sessionId: session.id, cwd: root, cols: 80, rows: 24 })
  // The manager has no persistent terminal table; its one-record map is probed via its public quota.
  const terminalSnapshot = () => {
    assert.throws(() => manager.create({ sessionId: session.id, cwd: root, cols: 2, rows: 2 }), /Terminal limit reached/)
    return { existing, managerRecords: 1, spawned, ptyRecords: structuredClone([...ptys.entries()]) }
  }
  t.after(() => manager.disposeAll())
  let effects = 0
  socket.on('message', raw => {
    const frame = JSON.parse(raw.toString())
    if (frame.frameType !== 'data' || !['terminal.request', 'fs.request'].includes(frame.payload.type)) return
    effects++
    const payload = frame.payload
    if (payload.type === 'terminal.request') {
      if (payload.operation === 'write') manager.write(payload.sessionId, payload.terminalId, payload.data)
      if (payload.operation === 'resize') manager.resize(payload.sessionId, payload.terminalId, payload.cols, payload.rows)
      if (payload.operation === 'dispose') manager.dispose(payload.sessionId, payload.terminalId)
    }
    peer.send(effectResponse(frame.payload))
  })
  await peer.connect({ name: 'write-closed-worker' })
  await new Promise(resolve => setTimeout(resolve, 100))
  const db = new DatabaseSync(path, { readOnly: true }), transport = new DatabaseSync(`${path}.transport`, { readOnly: true })
  t.after(async () => { db.close(); transport.close(); await peer.close(); await app.close(); await rm(root, { recursive: true, force: true }) })
  const snapshot = async () => ({
    sessions: db.prepare("SELECT count(*) AS n FROM records WHERE kind='session'").get(),
    forks: db.prepare("SELECT count(*) AS n FROM records WHERE kind='session-fork'").get(),
    commands: db.prepare('SELECT count(*) AS n FROM commands').get(),
    outbox: transport.prepare('SELECT count(*) AS n FROM transport_outbox').get(),
    // ACK may remove outbox rows: the monotonic sequence also detects transient appends.
    sequences: transport.prepare("SELECT worker_id,key,value FROM transport_meta WHERE key LIKE 'outbound_last_seq:%' ORDER BY worker_id,key").all(),
    effects, content: await readFile(file), mtimeMs: (await stat(file)).mtimeMs, size: (await stat(file)).size, terminals: terminalSnapshot(),
  })
  const initial = await snapshot()
  t.diagnostic(JSON.stringify({ sessions: initial.sessions, forks: initial.forks, commands: initial.commands, outbox: initial.outbox, sequences: initial.sequences, effects: initial.effects }))
  const request = async (suffix: string, body: unknown, token: string | null = administratorToken, id = session.id, cookie?: string) => {
    const response = await fetch(`${base}/api/sessions/${id}${suffix}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) })
    const text = await response.text()
    for (const secret of [session.id, project.id, workspace.id, enrolled.worker.id, root, 'private-title-sentinel', 'private-content-sentinel', 'synthetic input', 'synthetic-terminal', 'fixture.txt', 'YQ==']) assert.ok(!text.includes(secret), `response leaked ${secret}`)
    return { status: response.status, headers: Object.fromEntries(response.headers), text }
  }
  return { app, session, reader, snapshot, request, existing, terminalSnapshot }
}

// Every individual denial, including platform-authentication failures, has its own before/after snapshot.
async function unchanged<T>(f: Awaited<ReturnType<typeof fixture>>, action: () => Promise<T>): Promise<T> {
  const before = await f.snapshot()
  try { return await action() } finally { assert.deepEqual(await f.snapshot(), before) }
}

for (const effect of sessionEffects) {
  test(`terminal-write-closed HTTP ${effect.path}: authorized request has exact policy error and zero residue`, async t => {
    const f = await fixture(t)
    for (const body of [effect.body, null]) {
      const response = await unchanged(f, () => f.request(effect.path, body))
      assert.equal(response.status, 403)
      assert.equal(response.text, JSON.stringify(closed))
    }
  })
}

test('terminal-write-closed authenticated equivalence matrix compares status, complete headers and body bytes', async t => {
  const f = await fixture(t)
  const original = (await f.app.store.resources.getSession(f.session.id))!
  const task = (await f.app.store.tasks.get(original.taskId!))!
  const rows = ['manager', 'viewer', 'missing-session', 'hidden-session', 'missing-terminal', 'existing-terminal', 'invalid-body', 'deleted-task', 'deleted-session'] as const
  let baseline: Awaited<ReturnType<typeof f.request>> | undefined
  for (const name of rows) {
    await f.app.store.transaction(async tx => {
      await tx.resources.saveSession({ ...original, shareScope: name === 'hidden-session' ? 'owner-only' : 'project', deletedAt: name === 'deleted-session' ? new Date().toISOString() as never : null })
      await tx.tasks.save({ ...task, deletedAt: name === 'deleted-task' || name === 'deleted-session' ? new Date().toISOString() : null })
      await tx.identity.saveProjectGrant({ projectId: original.projectId, userId: f.reader.userId, role: name === 'manager' ? 'manager' : 'viewer' })
    })
    for (const effect of sessionEffects) {
      const path = effect.path.replace('synthetic-terminal', name === 'existing-terminal' ? f.existing.terminalId : 'missing-terminal')
      const response = await unchanged(f, () => f.request(path, name === 'invalid-body' ? null : effect.body, f.reader.token, name === 'missing-session' ? 'missing-session' as SessionId : f.session.id))
      if (!baseline) {
        baseline = response
        assert.equal(response.status, 403); assert.equal(response.text, JSON.stringify(closed))
        t.diagnostic(`equivalence baseline ${JSON.stringify(baseline)}`)
      }
      assert.deepEqual(response, baseline, `${name} ${effect.path}: authenticated responses must be byte-identical`)
    }
  }
  t.diagnostic(`equivalence matrix: ${rows.length} combinations x ${sessionEffects.length} entrypoints`)
})

test('terminal-write-closed platform authentication: anonymous, expired Cookie and insufficient PAT scope stay outside the matrix', async t => {
  const f = await fixture(t)
  // These are platform credential/scope checks, not Session authorization or policy-equivalence cases.
  const anonymous = await unchanged(f, () => f.request('/terminal', {}, null))
  assert.equal(anonymous.status, 401); assert.equal(JSON.parse(anonymous.text).error.code, 'authentication_required')
  const cookie = await unchanged(f, () => f.request('/terminal', {}, null, f.session.id, 'wemux_login_session=expired-cookie'))
  assert.equal(cookie.status, 401); assert.equal(JSON.parse(cookie.text).error.code, 'authentication_required')
  assert.match(cookie.headers['set-cookie'], /wemux_login_session=;/)
  assert.match(cookie.headers['set-cookie'], /Max-Age=0/)
  const pat = (await f.app.store.identity.findPersonalAccessToken(hashSecret(f.reader.token)))!
  await f.app.store.transaction(tx => tx.identity.savePersonalAccessToken({ ...pat, scopes: ['read'] }))
  const scope = await unchanged(f, () => f.request('/terminal', {}, f.reader.token))
  assert.equal(scope.status, 403); assert.equal(JSON.parse(scope.text).error.code, 'pat_scope_required')
})

test('terminal-write-closed handlers ignore missing injection and never inspect resources or parse bodies', async () => {
  let authenticated = 0
  const context = new Proxy({ actor: async () => { authenticated++; return instanceOperatorId } }, {
    get(target, key) { if (key === 'actor') return target.actor; throw new Error(`Forbidden resource/injection access: ${String(key)}`) },
  }) as unknown as RouteRequestContext
  const patterns = ['/sessions/:sessionId/fs/write', '/sessions/:sessionId/terminal', ...['write', 'resize', 'dispose'].map(operation => `/sessions/:sessionId/terminal/:terminalId/${operation}`)]
  for (const pattern of patterns) {
    const route = sessionRoutes.find(route => route.method === 'POST' && route.pattern === pattern)!
    await assert.rejects(async () => route.handler(context), { status: 403, code: closed.error.code, message: closed.error.message })
  }
  assert.equal(authenticated, 5)
})

test('terminal-write-closed direct services ignore actor and target state without waiter, send or seeded terminal changes', async t => {
  const f = await fixture(t)
  const workers = new WorkerService(f.app.store, f.app.service.notifications)
  let waiters = 0, sends = 0
  const registerFile = workers.registerFileRequest.bind(workers), registerTerminal = workers.registerTerminalRequest.bind(workers)
  workers.registerFileRequest = (...args) => { waiters++; return registerFile(...args) }
  workers.registerTerminalRequest = (...args) => { waiters++; return registerTerminal(...args) }
  const gateway = { async send() { sends++; throw new AppError(502, 'unexpected dispatch') } }
  const files = new SessionFileService(f.app.service, workers, gateway)
  const terminals = new SessionTerminalService(f.app.service, workers, gateway)
  const operations = [
    (actor?: typeof instanceOperatorId, id = f.session.id) => files.write(id, 'fixture.txt', 'YQ==', actor),
    ...([{ operation: 'create', cols: 80, rows: 24 }, { operation: 'write', terminalId: f.existing.terminalId, data: 'synthetic input' }, { operation: 'resize', terminalId: f.existing.terminalId, cols: 90, rows: 30 }, { operation: 'dispose', terminalId: f.existing.terminalId }] as const).map(input => (actor?: typeof instanceOperatorId, id = f.session.id) => terminals.request(id, input, actor)),
  ]
  for (const operation of operations) {
    for (const actor of [undefined, f.reader.userId, instanceOperatorId]) {
      for (const id of [f.session.id, 'missing-session' as SessionId]) {
        await unchanged(f, () => assert.rejects(operation(actor, id), { status: 403, code: closed.error.code, message: closed.error.message }))
        assert.equal(waiters, 0); assert.equal(sends, 0)
      }
    }
  }
})
