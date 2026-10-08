import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionId, WorkerId } from '@wemux/domain'
import type { ServerToWorker, WorkerToServer } from '@wemux/wire-protocol'
import { WorkerRuntime } from '../src/application/runtime.ts'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.ts'
import { TerminalManager, type PtyAdapter, type PtyProcess } from '../src/terminal/terminal-manager.ts'

const error = 'write_channel_closed: 平台当前未开放文件和终端写入通道。'
const workerId = 'worker-closed' as WorkerId
const sessionId = 'session-closed' as SessionId
class MemoryPty implements PtyAdapter {
  calls = { spawn: 0, write: 0, resize: 0, kill: 0, subscribe: 0, dispose: 0 }
  spawn(): PtyProcess {
    this.calls.spawn++
    return { pid: 42, write: () => { this.calls.write++ }, resize: () => { this.calls.resize++ }, kill: () => { this.calls.kill++ },
      onData: () => { this.calls.subscribe++; return { dispose: () => { this.calls.dispose++ } } },
      onExit: () => { this.calls.subscribe++; return { dispose: () => { this.calls.dispose++ } } } }
  }
}
async function fixture(t: TestContext, withPty = true) {
  const home = await mkdtemp(join(tmpdir(), 'runtime-write-closed-')), root = join(home, 'workspace')
  await mkdir(root)
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  const workspace = { id: 'workspace-closed' as never, workerId, projectId: 'project-closed' as never, rootPath: root,
    spec: { kind: 'empty' as const }, status: 'ready' as const, failureReason: null, updatedAt: '2026-01-01T00:00:00Z' as never }
  const binding = { workspaceId: workspace.id, agent: { workerId, agentKey: 'test' as never }, modelId: null }
  await store.transaction(async tx => { await tx.workspaces.save(workspace); await tx.sessions.createSession(sessionId, binding) })
  const pty = new MemoryPty(), sent: WorkerToServer[] = []
  const runtime = new WorkerRuntime(store, { provision: async () => { throw Error('unexpected provision') } }, [],
    { send: message => { sent.push(message) } }, workerId, 'closed', undefined, undefined, undefined, withPty ? pty : null)
  const observer = new DatabaseSync(join(home, 'worker.sqlite'))
  t.after(async () => { await runtime.shutdown(); observer.close(); store.close(); await rm(home, { recursive: true, force: true }) })
  const counts = () => ['worker_file_admissions', 'worker_file_results', 'worker_file_result_delivery'].map(table => observer.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)
  return { runtime, store, root, sent, pty, workspace, binding, counts }
}
function requests(terminalId = 'missing'): ServerToWorker[] {
  return [
    { type: 'fs.request', requestId: 'file', sessionId, operation: 'write', subpath: 'new/nested.bin', base64Content: 'AP8=' },
    { type: 'terminal.request', requestId: 'create', sessionId, operation: 'create', cols: 80, rows: 24 },
    { type: 'terminal.request', requestId: 'write', sessionId, operation: 'write', terminalId, data: 'touch should-not-exist\r' },
    { type: 'terminal.request', requestId: 'resize', sessionId, operation: 'resize', terminalId, cols: 120, rows: 40 },
    { type: 'terminal.request', requestId: 'dispose', sessionId, operation: 'dispose', terminalId },
  ]
}
async function deny(f: Awaited<ReturnType<typeof fixture>>, request: ServerToWorker) {
  assert(request.type === 'fs.request' || request.type === 'terminal.request')
  await f.runtime.receive(request)
  assert.deepEqual(f.sent.pop(), { type: request.type === 'fs.request' ? 'fs.response' : 'terminal.response', requestId: request.requestId, ok: false, error })
}

test('direct file write preserves binary bytes, metadata and absent parents without admission effects', async t => {
  const f = await fixture(t), bytes = Buffer.from([0, 255, 128, 13, 10])
  await writeFile(join(f.root, 'existing.bin'), bytes)
  const before = await stat(join(f.root, 'existing.bin')), counts = f.counts()
  for (const subpath of ['existing.bin', 'new/nested.bin', '../escape', '/absolute', 'bad\0path']) {
    await deny(f, { type: 'fs.request', requestId: subpath, sessionId, operation: 'write', subpath, base64Content: subpath === 'existing.bin' ? 'bmV3' : 'invalid%%' })
    assert.deepEqual(await readFile(join(f.root, 'existing.bin')), bytes)
    const after = await stat(join(f.root, 'existing.bin'))
    assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs)
    assert.deepEqual(await readdir(f.root), ['existing.bin'])
    assert.deepEqual(f.counts(), counts)
  }
  assert.equal(f.pty.calls.spawn, 0)
})

for (const operation of ['create', 'write', 'resize', 'dispose'] as const) {
  test(`direct terminal ${operation} refuses an existing valid terminal without PTY or mapping effects`, async t => {
    const f = await fixture(t)
    // Test-local inspection: seed a pre-existing terminal, without opening a production hook.
    const internals = f.runtime as unknown as { terminals: TerminalManager; terminalSessions: Map<string, SessionId> }
    const created = internals.terminals.create({ sessionId, cwd: f.root, cols: 80, rows: 24 })
    internals.terminalSessions.set(created.terminalId, sessionId)
    const calls = { ...f.pty.calls }, mappings = [...internals.terminalSessions]
    await deny(f, requests(created.terminalId).find(request => request.type === 'terminal.request' && request.operation === operation)!)
    assert.deepEqual(f.pty.calls, calls)
    assert.deepEqual([...internals.terminalSessions], mappings)
    assert.equal(created.pid, 42)
    assert.deepEqual(await readdir(f.root), [])
    // A retained slot still counts towards the five-terminal quota.
    for (let i = 0; i < 4; i++) internals.terminals.create({ sessionId, cwd: f.root, cols: 80, rows: 24 })
    assert.throws(() => internals.terminals.create({ sessionId, cwd: f.root, cols: 80, rows: 24 }), /Terminal limit/)
    await f.runtime.shutdown()
    assert.equal(f.pty.calls.kill, 5); assert.equal(f.pty.calls.dispose, 10)
  })
}

test('policy precedes missing/local Session, unready/foreign Workspace and unavailable PTY lookups', async t => {
  for (const withPty of [false, true]) {
    const f = await fixture(t, withPty)
    f.store.saveLocalInstallation({ installationId: 'local', name: 'local', createdAt: '2026-01-01T00:00:00Z' as never })
    await f.store.transaction(async tx => {
      await tx.sessions.createSession('local-session' as SessionId, { ...f.binding, agent: { ...f.binding.agent, workerId: 'local-local' as WorkerId } })
      await tx.workspaces.save({ ...f.workspace, status: 'failed', workerId: 'foreign' as WorkerId })
    })
    await f.store.transaction(async tx => {
      await tx.sessions.createSession('deleted-session' as SessionId, f.binding)
      await tx.sessions.deleteSession('deleted-session' as SessionId)
    })
    for (const id of [sessionId, 'missing-session', 'deleted-session', 'local-session']) {
      for (const request of requests()) await deny(f, { ...request, sessionId: id } as ServerToWorker)
    }
    const getSession = f.store.sessions.get, getWorkspace = f.store.workspaces.get
    let lookups = 0
    f.store.sessions.get = async () => { lookups++; throw Error('Session lookup forbidden') }
    f.store.workspaces.get = async () => { lookups++; throw Error('Workspace lookup forbidden') }
    try { for (const request of requests()) await deny(f, request); assert.equal(lookups, 0) }
    finally { f.store.sessions.get = getSession; f.store.workspaces.get = getWorkspace }
    assert.deepEqual(f.pty.calls, { spawn: 0, write: 0, resize: 0, kill: 0, subscribe: 0, dispose: 0 })
  }
})

test('same Runtime retains list/read/diff and shutdown ignores subsequent direct requests', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'read.txt'), 'unchanged')
  for (const request of requests()) await deny(f, request)
  for (const operation of ['list', 'read', 'diff'] as const) {
    await f.runtime.receive({ type: 'fs.request', requestId: operation, sessionId, operation, subpath: operation === 'list' ? '' : 'read.txt', maxBytes: 1024 })
    const result = f.sent.pop()
    assert(result?.type === 'fs.response' && result.ok && result.operation === operation)
    if (result.operation === 'read') assert.equal(result.content, 'unchanged')
    if (result.operation === 'list') assert.equal(result.entries[0]?.name, 'read.txt')
    if (result.operation === 'diff') assert.equal(result.supported, false)
  }
  await f.runtime.shutdown()
  for (const request of requests()) await f.runtime.receive(request)
  assert.deepEqual(f.sent, []); assert.deepEqual(await readdir(f.root), ['read.txt'])
})
