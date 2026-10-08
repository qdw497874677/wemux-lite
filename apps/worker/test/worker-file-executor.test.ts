import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FileWriteAdmitPayload, WorkerToServer } from '@wemux/wire-protocol'
import { computeFileWriteFingerprint, parseFileWriteResult } from '@wemux/wire-protocol/file-admission-node'
import { WorkerFileWriteExecutor } from '../src/application/file-write-executor.js'
import { WorkerRuntime } from '../src/application/runtime.js'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'
import { writeWorkspaceFile } from '../src/files/workspace-files.js'
import type { LocalWorkspace } from '../src/domain/local-workspace.js'

function admission(requestId = 'admission-1'): FileWriteAdmitPayload {
  const value = {
    type: 'fs.write.admit', requestId, actorId: 'actor-1', sessionId: 'session-1', clientRequestId: 'client-1',
    operation: 'fs.write', workerId: 'worker-1',
    binding: { workspaceId: 'workspace-1', agent: { workerId: 'worker-1', agentKey: 'pi' }, modelId: null },
    subpath: 'notes/你好.txt', base64Content: 'aGVsbG8=', fingerprintVersion: 1,
  } as Omit<FileWriteAdmitPayload, 'fingerprint'>
  return { ...value, fingerprint: computeFileWriteFingerprint(value) }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'worker-file-executor-'))
  const path = join(dir, 'worker.sqlite'), root = join(dir, 'workspace')
  await mkdir(root)
  let store = new SqliteWorkerStore(path)
  const a = admission()
  store.saveIdentity({ workerId: a.workerId, serverUrl: 'https://unused.invalid', credentialRef: 'synthetic-unused', enrolledAt: '2026-01-01T00:00:00Z' as never })
  store.saveLocalInstallation({ installationId: 'install-1', name: 'local', createdAt: '2026-01-01T00:00:00Z' as never })
  const workspace: LocalWorkspace = { id: a.binding.workspaceId, workerId: a.workerId, projectId: 'project-1' as never, rootPath: root,
    spec: { kind: 'composite', memberWorkspaceIds: [] }, status: 'ready', failureReason: null, updatedAt: '2026-01-01T00:00:00Z' as never }
  await store.transaction(async tx => {
    await tx.workspaces.save(workspace)
    await tx.sessions.createSession(a.sessionId, a.binding)
  })
  const observer = new DatabaseSync(path)
  t.after(async () => { observer.close(); store.close(); await rm(dir, { recursive: true, force: true }) })
  return { get store() { return store }, a, root, observer, workspace,
    reopen() { store.close(); store = new SqliteWorkerStore(path); return store },
    counts() { return ['worker_file_admissions', 'worker_file_results', 'worker_file_result_delivery'].map(table => Number(observer.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)) },
  }
}

test('real helper observes committed reservation and publishes exact committed success/delivery bytes', async t => {
  const f = await fixture(t)
  let calls = 0, publications = 0
  const executor = new WorkerFileWriteExecutor(f.store, f.a.workerId, {
    write: async (...args) => {
      calls++
      assert.deepEqual(f.counts(), [1, 0, 0])
      assert.deepEqual((await f.store.fileWrites.get(f.a.requestId))?.admission, f.a)
      return writeWorkspaceFile(...args)
    },
    publish: async result => {
      publications++
      assert.deepEqual(f.counts(), [1, 1, 1])
      assert.deepEqual(result, (await f.store.fileWrites.listPendingResults(10))[0])
      assert(Object.isFrozen(result))
      assert.equal(await readFile(join(f.root, f.a.subpath), 'utf8'), 'hello')
    },
  })
  const first = await executor.execute(f.a)
  assert.equal(first.status, 'result')
  if (first.status !== 'result') throw Error('fixture')
  assert.equal(first.result.resultJson, '{"ok":true,"operation":"write","subpath":"notes/你好.txt","size":5}')
  assert.deepEqual(parseFileWriteResult(first.result, f.a), first.result)
  assert.deepEqual(await executor.execute(f.a), first)
  assert.equal(calls, 1)
  assert.equal(publications, 2)
  assert.equal((await f.store.fileWrites.get(f.a.requestId))?.acknowledged, false)
  await executor.close()
  const reopened = new WorkerFileWriteExecutor(f.reopen(), f.a.workerId, { write: async () => { throw Error('must not execute') } })
  assert.deepEqual(await reopened.execute(f.a), first)
})

test('outer reservation rollback and rejected post-commit resolution grant no effect', async t => {
  for (const committed of [false, true]) {
    const f = await fixture(t)
    const original = f.store.transaction.bind(f.store)
    f.store.transaction = async work => {
      if (committed) { await original(work); throw Error('outer resolution failed') }
      return original(async tx => { await work(tx); throw Error('outer resolution failed') })
    }
    let calls = 0
    const executor = new WorkerFileWriteExecutor(f.store, f.a.workerId, { write: async () => { calls++; throw Error('unexpected') } })
    await assert.rejects(executor.execute(f.a), /outer resolution failed/)
    assert.equal(calls, 0)
    assert.deepEqual(await readdir(f.root), [])
    assert.deepEqual(f.counts(), [committed ? 1 : 0, 0, 0])
    f.store.transaction = original
    if (committed) assert.deepEqual(await executor.execute(f.a), { status: 'await-existing' })
  }
})

test('snapshot precedes authorization await and queue; caller mutation cannot change any admitted primitive', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  const originalGet = f.store.sessions.get.bind(f.store.sessions)
  f.store.sessions.get = async id => { entered.resolve(); await release.promise; return originalGet(id) }
  const executor = new WorkerFileWriteExecutor(f.store, f.a.workerId)
  const first = structuredClone(f.a), second = admission('admission-2')
  const originalSecond = structuredClone(second)
  const one = executor.execute(first)
  await entered.promise
  const two = executor.execute(second)
  for (const value of [first, second]) {
    Object.assign(value, { subpath: '../escape', base64Content: '', actorId: 'changed', requestId: 'changed', sessionId: 'changed', clientRequestId: 'changed', fingerprint: '0'.repeat(64) })
    Object.assign(value.binding, { workspaceId: 'changed', modelId: 'changed' })
    Object.assign(value.binding.agent, { agentKey: 'changed', workerId: 'changed' })
  }
  release.resolve()
  assert.equal((await one).status, 'result')
  assert.equal((await two).status, 'result')
  assert.deepEqual((await f.store.fileWrites.get(f.a.requestId))?.admission, f.a)
  assert.deepEqual((await f.store.fileWrites.get(originalSecond.requestId))?.admission, originalSecond)
  assert.equal(await readFile(join(f.root, f.a.subpath), 'utf8'), 'hello')
})

test('malformed and hash-invalid admissions never reserve, publish or write', async t => {
  const f = await fixture(t)
  const executor = new WorkerFileWriteExecutor(f.store, f.a.workerId, { write: async () => { assert.fail('effect') }, publish: async () => { assert.fail('publication') } })
  for (const value of [null, { ...f.a, extra: true }, { ...f.a, subpath: '../escape' }, { ...f.a, base64Content: '!!!!' }, { ...f.a, fingerprint: '0'.repeat(64) }]) {
    await assert.rejects(executor.execute(value))
  }
  assert.deepEqual(f.counts(), [0, 0, 0])
  assert.deepEqual(await readdir(f.root), [])
})

test('actual Worker, full Session binding, local host and Workspace eligibility deny before reservation', async t => {
  const cases: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>]> = [
    ['unregistered', async f => { f.store.clearIdentity() }],
    ['different registered Worker', async f => { f.store.saveIdentity({ ...f.store.identity()!, workerId: 'other' as never }) }],
    ['missing Session', async f => { await f.store.transaction(tx => tx.sessions.deleteSession(f.a.sessionId)) }],
    ...[
      { workspaceId: 'other' }, { modelId: 'other' },
      { agent: { workerId: 'other', agentKey: 'pi' } },
      { agent: { workerId: 'worker-1', agentKey: 'other' } },
      { agent: { workerId: 'local-install-1', agentKey: 'pi' } },
    ].map(binding => ['Session binding', async (f: Awaited<ReturnType<typeof fixture>>) => {
      await f.store.transaction(tx => tx.sessions.createSession('other-session' as never, { ...f.a.binding, ...binding } as typeof f.a.binding))
      Object.assign(f.a, { sessionId: 'other-session' }); Object.assign(f.a, { fingerprint: computeFileWriteFingerprint(f.a) })
    }] as [string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>]),
    ['missing Workspace', async f => { await f.store.transaction(tx => tx.workspaces.remove(f.workspace.id)) }],
    ...[{ status: 'failed' }, { workerId: 'other' }, { workerId: 'local-install-1' }, { projectId: 'local' }, { rootPath: '' }].map(change => ['Workspace', async (f: Awaited<ReturnType<typeof fixture>>) => {
      await f.store.transaction(tx => tx.workspaces.save({ ...f.workspace, ...change } as LocalWorkspace))
    }] as [string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>]),
    ['target Worker', async f => {
      Object.assign(f.a, { workerId: 'other' }); Object.assign(f.a.binding.agent, { workerId: 'other' })
      Object.assign(f.a, { fingerprint: computeFileWriteFingerprint(f.a) })
    }],
  ]
  for (const [name, change] of cases) {
    const f = await fixture(t)
    await change(f)
    const executor = new WorkerFileWriteExecutor(f.store, 'worker-1' as never, { write: async () => { assert.fail(name) }, publish: async () => { assert.fail(name) } })
    await assert.rejects(executor.execute(f.a), /mismatch|eligible/, name)
    assert.deepEqual(f.counts(), [0, 0, 0], name)
    assert.deepEqual(await readdir(f.root), [], name)
  }
})

test('concurrent duplicates invoke once; conflicts and later unauthorized retries disclose no retained result', async t => {
  const f = await fixture(t)
  let calls = 0, publications = 0
  const executor = new WorkerFileWriteExecutor(f.store, f.a.workerId, { write: async (...args) => { calls++; return writeWorkspaceFile(...args) }, publish: async () => { publications++ } })
  const results = await Promise.all(Array.from({ length: 20 }, () => executor.execute(f.a)))
  for (const result of results) assert.deepEqual(result, results[0])
  assert.equal(calls, 1)
  assert.equal(publications, 20)
  for (const change of [{ actorId: 'other' }, { clientRequestId: 'other' }, { subpath: 'other' }, { base64Content: '' }]) {
    const value = { ...f.a, ...change }
    value.fingerprint = computeFileWriteFingerprint(value)
    assert.deepEqual(await executor.execute(value), { status: 'reject', reason: 'identity-conflict' })
  }
  await f.store.transaction(tx => tx.workspaces.save({ ...f.workspace, status: 'failed' }))
  await assert.rejects(executor.execute(f.a), /eligible/)
  assert.equal(calls, 1)
  assert.equal(publications, 20)
})

test('unresolved duplicates, including normal reopen, never execute or implicitly recover', async t => {
  const f = await fixture(t)
  await f.store.transaction(tx => tx.fileWrites.reserve(f.a))
  for (const reopen of [false, true]) {
    const executor = new WorkerFileWriteExecutor(reopen ? f.reopen() : f.store, f.a.workerId, { write: async () => { assert.fail('effect') }, publish: async () => { assert.fail('publication') } })
    assert.deepEqual(await executor.execute(f.a), { status: 'await-existing' })
    assert.deepEqual(f.counts(), [1, 0, 0])
  }
})

test('partial write then throw retains unknown, immutable exact replay survives reopen', async t => {
  const f = await fixture(t)
  let calls = 0
  const executor = new WorkerFileWriteExecutor(f.store, f.a.workerId, { write: async (root, subpath) => {
    calls++; await mkdir(join(root, 'notes')); await writeFile(join(root, subpath), 'partial'); throw Error('after truncation')
  } })
  const first = await executor.execute(f.a)
  assert.equal(first.status, 'result')
  if (first.status !== 'result') throw Error('fixture')
  assert.equal(first.result.outcome, 'unknown')
  assert.equal(first.result.resultJson, '{"ok":false,"operation":"write","effect":"uncertain","error":"File write outcome is uncertain"}')
  assert.equal(await readFile(join(f.root, f.a.subpath), 'utf8'), 'partial')
  assert.deepEqual(await executor.execute(f.a), first)
  assert.equal(calls, 1)
  const reopened = new WorkerFileWriteExecutor(f.reopen(), f.a.workerId, { write: async () => { assert.fail('effect') } })
  assert.deepEqual(await reopened.execute(f.a), first)
  assert.deepEqual(await f.store.fileWrites.listPendingResults(10), [first.result])
})

test('separate executors observe unresolved concurrent reservation without a second invocation', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  const first = new WorkerFileWriteExecutor(f.store, f.a.workerId, { write: async (...args) => { entered.resolve(); await release.promise; return writeWorkspaceFile(...args) } })
  const second = new WorkerFileWriteExecutor(f.store, f.a.workerId, { write: async () => { assert.fail('second invocation') } })
  const pending = first.execute(f.a)
  await entered.promise
  assert.deepEqual(await second.execute(f.a), { status: 'await-existing' })
  release.resolve()
  const settled = await pending
  assert.deepEqual(await second.execute(f.a), settled)
})

test('real helper sandbox denial retains unknown and leaves the outside target untouched', async t => {
  const f = await fixture(t), outside = join(f.root, '..', 'outside.txt')
  await writeFile(outside, 'untouched')
  await mkdir(join(f.root, 'notes'))
  await symlink(outside, join(f.root, f.a.subpath))
  const result = await new WorkerFileWriteExecutor(f.store, f.a.workerId).execute(f.a)
  assert.equal(result.status === 'result' && result.result.outcome, 'unknown')
  assert.equal(await readFile(outside, 'utf8'), 'untouched')
  assert.deepEqual(f.counts(), [1, 1, 1])
})

test('all helper errors, including missing root, are unknown after entry', async t => {
  const f = await fixture(t)
  await rm(f.root, { recursive: true })
  const result = await new WorkerFileWriteExecutor(f.store, f.a.workerId).execute(f.a)
  assert.equal(result.status === 'result' && result.result.outcome, 'unknown')
})

test('settlement rollback leaves unresolved dedupe, no exposed result or delivery, no retry', async t => {
  const f = await fixture(t), original = f.store.transaction.bind(f.store)
  let transaction = 0, calls = 0
  f.store.transaction = work => original(async tx => {
    const value = await work(tx)
    if (++transaction === 2) throw Error('settlement failed')
    return value
  })
  const executor = new WorkerFileWriteExecutor(f.store, f.a.workerId, { write: async (...args) => { calls++; return writeWorkspaceFile(...args) }, publish: async () => { assert.fail('publication') } })
  await assert.rejects(executor.execute(f.a), /settlement failed/)
  assert.equal(await readFile(join(f.root, f.a.subpath), 'utf8'), 'hello')
  assert.deepEqual(f.counts(), [1, 0, 0])
  assert.deepEqual(await executor.execute(f.a), { status: 'await-existing' })
  assert.equal(calls, 1)
})

test('post-commit settlement failure and publication failure preserve pending exact bytes and dedupe', async t => {
  for (const failure of ['settlement', 'publication']) {
    const f = await fixture(t), original = f.store.transaction.bind(f.store)
    let transaction = 0, calls = 0, publishes = 0
    f.store.transaction = async work => {
      const value = await original(work)
      if (++transaction === 2 && failure === 'settlement') throw Error('post-commit failed')
      return value
    }
    const executor = new WorkerFileWriteExecutor(f.store, f.a.workerId, {
      write: async (...args) => { calls++; return writeWorkspaceFile(...args) },
      publish: async () => { if (++publishes === 1 && failure === 'publication') throw Error('publication failed') },
    })
    await assert.rejects(executor.execute(f.a), /failed/)
    const retained = (await f.store.fileWrites.listPendingResults(10))[0]
    assert.deepEqual(f.counts(), [1, 1, 1])
    assert.deepEqual(await executor.execute(f.a), { status: 'result', result: retained })
    assert.equal(calls, 1)
    assert.deepEqual(await f.store.fileWrites.listPendingResults(10), [retained])
  }
})

test('executor close drains active effect and settlement but rejects queued and new work', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  const executor = new WorkerFileWriteExecutor(f.store, f.a.workerId, { write: async (...args) => { entered.resolve(); await release.promise; return writeWorkspaceFile(...args) } })
  const first = executor.execute(f.a)
  await entered.promise
  const queued = assert.rejects(executor.execute(admission('queued')), /closing/)
  let closed = false
  const close = executor.close().then(() => { closed = true })
  await assert.rejects(executor.execute(admission('new')), /closing/)
  assert.equal(closed, false)
  release.resolve()
  assert.equal((await first).status, 'result')
  await queued; await close
  assert.equal(closed, true)
  assert.deepEqual(f.counts(), [1, 1, 1])
})

test('default Runtime ignores new messages and reconnect does not recover, advertise or send retained results; legacy write is closed', async t => {
  const f = await fixture(t), sent: WorkerToServer[] = []
  const runtime = new WorkerRuntime(f.store, { provision: async () => { assert.fail('provision') } }, [], { send: message => { sent.push(message) } }, f.a.workerId, 'offline')
  t.after(() => runtime.shutdown())
  await runtime.receive(f.a)
  assert.deepEqual(f.counts(), [0, 0, 0])
  assert.deepEqual(await readdir(f.root), [])
  assert.deepEqual(sent, [])
  await runtime.receive({ type: 'fs.request', requestId: 'legacy', sessionId: f.a.sessionId, operation: 'write', subpath: 'legacy.txt', base64Content: f.a.base64Content })
  assert.deepEqual(sent.pop(), { type: 'fs.response', requestId: 'legacy', ok: false, error: 'write_channel_closed: 平台当前未开放文件和终端写入通道。' })
  assert.equal((await readdir(f.root)).includes('legacy.txt'), false)
  await f.store.transaction(tx => tx.fileWrites.reserve(f.a))
  const settled = await new WorkerFileWriteExecutor(f.store, f.a.workerId).execute(admission('settled'))
  assert.equal(settled.status, 'result')
  if (settled.status !== 'result') throw Error('fixture')
  const { outcome: _outcome, resultJson: _resultJson, ...ackIdentity } = settled.result
  await runtime.receive({ ...ackIdentity, type: 'fs.write.result.ack' })
  assert.equal((await f.store.fileWrites.get('settled'))?.acknowledged, false)
  await runtime.initialize(); await runtime.connected(); await runtime.connected()
  assert.deepEqual(f.counts(), [2, 1, 1])
  assert.equal((await f.store.fileWrites.get(f.a.requestId))?.result, null)
  assert.equal(sent.some(message => message.type === 'fs.write.result'), false)
  assert.equal(JSON.stringify(sent).includes('fs-write-admission-v1'), false)
  const localSession = 'local-session' as typeof f.a.sessionId
  await f.store.transaction(tx => tx.sessions.createSession(localSession, { ...f.a.binding, agent: { ...f.a.binding.agent, workerId: 'local-install-1' as never } }))
  await runtime.receive({ type: 'fs.request', requestId: 'local', sessionId: localSession, operation: 'write', subpath: 'local.txt', base64Content: '' })
  assert.deepEqual(sent.pop(), { type: 'fs.response', requestId: 'local', ok: false, error: 'write_channel_closed: 平台当前未开放文件和终端写入通道。' })
  assert.equal((await readdir(f.root)).includes('local.txt'), false)
  await runtime.shutdown()
  await runtime.receive({ type: 'fs.request', requestId: 'closed', sessionId: f.a.sessionId, operation: 'write', subpath: 'closed.txt', base64Content: '' })
  assert.equal((await readdir(f.root)).includes('closed.txt'), false)
})
