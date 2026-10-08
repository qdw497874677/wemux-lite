import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { serializeFileWriteRetainedResult, type FileWriteAdmitPayload, type FileWriteResultAckPayload, type FileWriteResultPayload } from '@wemux/wire-protocol'
import { computeFileWriteFingerprint, computeFileWriteResultDigest, parseFileWriteAdmit, parseFileWriteResult } from '@wemux/wire-protocol/file-admission-node'
import type { WorkerStoreTx } from '../src/application/ports/worker-store.js'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'

function admission(requestId = 'admission-1'): FileWriteAdmitPayload {
  const input = {
    type: 'fs.write.admit', requestId, actorId: 'actor-1', sessionId: 'session-1', clientRequestId: 'client-1',
    operation: 'fs.write', workerId: 'worker-1',
    binding: { workspaceId: 'workspace-1', agent: { workerId: 'worker-1', agentKey: 'pi' }, modelId: null },
    subpath: 'notes/你好.txt', base64Content: 'aGVsbG8=', fingerprintVersion: 1,
  } as Omit<FileWriteAdmitPayload, 'fingerprint'>
  return { ...input, fingerprint: computeFileWriteFingerprint(input) }
}
function result(a = admission(), outcome: FileWriteResultPayload['outcome'] = 'succeeded'): FileWriteResultPayload {
  const value: Omit<FileWriteResultPayload, 'resultDigest'> = {
    type: 'fs.write.result', requestId: a.requestId, sessionId: a.sessionId, workerId: a.workerId,
    operation: a.operation, fingerprintVersion: a.fingerprintVersion, fingerprint: a.fingerprint,
    resultVersion: 1, outcome,
    resultJson: serializeFileWriteRetainedResult(outcome, outcome === 'succeeded'
      ? { ok: true, operation: 'write', subpath: a.subpath, size: 5 }
      : { ok: false, operation: 'write', effect: outcome === 'unknown' ? 'uncertain' : 'not-started', error: 'retained original error' }),
  }
  return { ...value, resultDigest: computeFileWriteResultDigest(value) }
}
function ack(r = result()): FileWriteResultAckPayload {
  const { outcome: _outcome, resultJson: _resultJson, ...identity } = r
  return { ...identity, type: 'fs.write.result.ack' }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'worker-file-store-'))
  const path = join(dir, 'worker.sqlite')
  let store = new SqliteWorkerStore(path)
  let closed = false
  const observer = new DatabaseSync(path)
  t.after(async () => { observer.close(); if (!closed) store.close(); await rm(dir, { recursive: true, force: true }) })
  const raw = () => ({
    admissions: observer.prepare('SELECT * FROM worker_file_admissions ORDER BY request_id').all(),
    results: observer.prepare('SELECT * FROM worker_file_results ORDER BY request_id').all(),
    delivery: observer.prepare('SELECT * FROM worker_file_result_delivery ORDER BY request_id').all(),
  })
  return { get store() { return store }, path, observer, raw,
    close() { store.close(); closed = true },
    reopen(readOnly = false) { if (!closed) store.close(); store = new SqliteWorkerStore(path, { readOnly }); closed = false; return store } }
}

test('concurrent identical admission reserves exactly one execute; all primitive conflicts preserve the original', async t => {
  const f = await fixture(t), a = admission()
  const decisions = await Promise.all(Array.from({ length: 20 }, () => f.store.transaction(tx => tx.fileWrites.reserve(a))))
  assert.equal(decisions.filter(item => item.status === 'execute').length, 1)
  assert.equal(decisions.filter(item => item.status === 'await-existing').length, 19)
  const before = f.raw()
  const alternatives = [
    { ...a, actorId: 'other' }, { ...a, sessionId: 'other' }, { ...a, clientRequestId: 'other' },
    { ...a, subpath: 'other.txt' }, { ...a, base64Content: '' },
    { ...a, binding: { ...a.binding, workspaceId: 'other' } },
    { ...a, binding: { ...a.binding, modelId: 'other' } },
    { ...a, binding: { ...a.binding, agent: { ...a.binding.agent, agentKey: 'other' } } },
    { ...a, workerId: 'other', binding: { ...a.binding, agent: { ...a.binding.agent, workerId: 'other' } } },
  ] as FileWriteAdmitPayload[]
  for (const item of alternatives) {
    const changed = { ...item, fingerprint: computeFileWriteFingerprint(item) }
    assert.deepEqual(await f.store.transaction(tx => tx.fileWrites.reserve(changed)), { status: 'reject', reason: 'identity-conflict' })
    assert.deepEqual(f.raw(), before)
  }
  // requestId is the admission identity, not the fingerprint or client provenance.
  assert.equal((await f.store.transaction(tx => tx.fileWrites.reserve({ ...a, requestId: 'separate-admission' }))).status, 'execute')
})

test('reservation validates fingerprint and shape rather than trusting structural validity', async t => {
  const f = await fixture(t), a = admission()
  for (const changed of [{ ...a, fingerprint: '0'.repeat(64) }, { ...a, subpath: 'changed.txt' }, { ...a, operation: 'fs.read' }, { ...a, extra: true }]) {
    await assert.rejects(f.store.transaction(tx => tx.fileWrites.reserve(changed as FileWriteAdmitPayload)))
    assert.deepEqual(f.raw(), { admissions: [], results: [], delivery: [] })
  }
})

test('reservation snapshots caller input synchronously and freezes returned nested values across await', async t => {
  const f = await fixture(t), a = admission(), original = structuredClone(a)
  const decision = await f.store.transaction(async tx => {
    const pending = tx.fileWrites.reserve(a)
    Object.assign(a.binding.agent, { agentKey: 'mutated' })
    Object.assign(a.binding, { modelId: 'mutated' })
    Object.assign(a, { base64Content: '', actorId: 'mutated' })
    const provisional = await pending
    assert.equal(provisional.status, 'execute')
    if (provisional.status !== 'execute') throw Error('fixture')
    assert.deepEqual(provisional.admission, original)
    assert.throws(() => Object.assign(provisional.admission.binding.agent, { agentKey: 'mutated' }), TypeError)
    return provisional
  })
  assert.equal(decision.status, 'execute')
  assert.deepEqual((await f.store.fileWrites.get(original.requestId))?.admission, original)
  assert.equal((await f.store.transaction(tx => tx.fileWrites.reserve(original))).status, 'await-existing')
})

test('observers and committed readers cannot see provisional reservation; execute resolves only after commit', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  let resolved = false, readResolved = false
  const outer = f.store.transaction(async tx => {
    const provisional = await tx.fileWrites.reserve(admission())
    entered.resolve(); await release.promise
    return provisional
  }).then(value => { resolved = true; return value })
  await entered.promise
  const read = f.store.fileWrites.get('admission-1').then(value => { readResolved = true; return value })
  const list = f.store.fileWrites.listPendingResults(10)
  await Promise.resolve()
  assert.deepEqual(f.raw(), { admissions: [], results: [], delivery: [] })
  assert.equal(resolved, false); assert.equal(readResolved, false)
  release.resolve()
  assert.equal((await outer).status, 'execute')
  assert.deepEqual((await read)?.admission, admission())
  assert.deepEqual(await list, [])
  assert.equal(f.raw().admissions.length, 1)
})

test('rollback rejects execution and atomically undoes reservation/result/delivery with Session and Journal writes', async t => {
  const f = await fixture(t), a = admission()
  await assert.rejects(f.store.transaction(async tx => {
    await tx.sessions.createSession(a.sessionId, a.binding)
    assert.equal((await tx.fileWrites.reserve(a)).status, 'execute')
    await tx.fileWrites.retainResult(result(a))
    throw Error('abort after reserve')
  }), /abort after reserve/)
  assert.deepEqual(f.raw(), { admissions: [], results: [], delivery: [] })
  assert.equal(await f.store.sessions.get(a.sessionId), null)
  assert.deepEqual(await f.store.journal.listHeads(), [])
  assert.equal((await f.store.transaction(tx => tx.fileWrites.reserve(a))).status, 'execute')
})

test('escaped transaction methods reject after commit, rollback, and during a later transaction', async t => {
  const f = await fixture(t)
  let committed!: WorkerStoreTx, rolledBack!: WorkerStoreTx
  await f.store.transaction(async tx => { committed = tx })
  await assert.rejects(f.store.transaction(async tx => { rolledBack = tx; throw Error('rollback') }))
  const a = admission()
  for (const tx of [committed, rolledBack]) {
    await assert.rejects(tx.fileWrites.reserve(a), /closed/)
    await assert.rejects(tx.fileWrites.retainResult(result(a)), /closed/)
    await assert.rejects(tx.fileWrites.acknowledgeResult(ack()), /closed/)
    await assert.rejects(tx.fileWrites.recoverUnresolved(), /closed/)
    await assert.rejects(tx.sessions.createSession(a.sessionId, a.binding), /closed/)
    await assert.rejects(tx.appendJournal(a.sessionId, []), /closed/)
  }
  await f.store.transaction(async () => { await assert.rejects(committed.fileWrites.reserve(a), /closed/) })
  assert.equal(await f.store.fileWrites.get(a.requestId), null)
})

test('retained result and application delivery become visible atomically; snapshot survives caller mutation', async t => {
  const f = await fixture(t), a = admission(), r = result(a), original = structuredClone(r)
  await f.store.transaction(tx => tx.fileWrites.reserve(a))
  const entered = deferred(), release = deferred()
  const outer = f.store.transaction(async tx => {
    const retaining = tx.fileWrites.retainResult(r)
    Object.assign(r, { resultJson: 'mutated', resultDigest: '0'.repeat(64) })
    await retaining
    entered.resolve(); await release.promise
  })
  await entered.promise
  assert.equal(f.raw().results.length, 0); assert.equal(f.raw().delivery.length, 0)
  release.resolve(); await outer
  assert.deepEqual(await f.store.fileWrites.listPendingResults(10), [original])
  assert.deepEqual((await f.store.fileWrites.get(a.requestId))?.result, original)
  const before = f.raw()
  await f.store.transaction(tx => tx.fileWrites.retainResult(original))
  assert.deepEqual(f.raw(), before)
  assert.deepEqual(await f.store.transaction(tx => tx.fileWrites.reserve(a)), { status: 'replay', result: original })
})

for (const failure of ['ABORT', 'FAIL'] as const) test(`caught ${failure} statement failure cannot orphan a retained result without delivery`, async t => {
  const f = await fixture(t), a = admission()
  f.observer.exec(`CREATE TRIGGER inject_delivery BEFORE INSERT ON worker_file_result_delivery BEGIN SELECT RAISE(${failure},'injected delivery failure'); END`)
  await f.store.transaction(async tx => {
    await tx.fileWrites.reserve(a)
    await assert.rejects(tx.fileWrites.retainResult(result(a)), /injected delivery failure/)
  })
  assert.equal(f.raw().admissions.length, 1)
  assert.deepEqual(f.raw().results, []); assert.deepEqual(f.raw().delivery, [])
  f.observer.exec('DROP TRIGGER inject_delivery')
  await f.store.transaction(tx => tx.fileWrites.retainResult(result(a)))
  assert.deepEqual(await f.store.fileWrites.listPendingResults(1), [result(a)])
})

test('tampered result digests, identities, success path/size and conflicting retained outcomes never replace bytes', async t => {
  const f = await fixture(t), a = admission(), r = result(a)
  await f.store.transaction(tx => tx.fileWrites.reserve(a))
  const invalid = [
    { ...r, resultDigest: '0'.repeat(64) },
    ...['requestId', 'sessionId', 'workerId', 'fingerprint'].map(key => {
      const changed = { ...r, [key]: key === 'fingerprint' ? '0'.repeat(64) : 'wrong' }
      return { ...changed, resultDigest: computeFileWriteResultDigest(changed) }
    }),
    ...[{ ok: true, operation: 'write', subpath: 'wrong.txt', size: 5 }, { ok: true, operation: 'write', subpath: a.subpath, size: 6 }].map(value => {
      const changed = { ...r, resultJson: JSON.stringify(value) }
      return { ...changed, resultDigest: computeFileWriteResultDigest(changed) }
    }),
    { ...r, resultJson: r.resultJson + ' ' },
  ]
  for (const changed of invalid) {
    await assert.rejects(f.store.transaction(tx => tx.fileWrites.retainResult(changed)))
    assert.equal(f.raw().results.length, 0); assert.equal(f.raw().delivery.length, 0)
  }
  await f.store.transaction(tx => tx.fileWrites.retainResult(r))
  const before = f.raw()
  for (const outcome of ['unknown', 'rejected-before-effect'] as const) {
    await assert.rejects(f.store.transaction(tx => tx.fileWrites.retainResult(result(a, outcome))), /conflict/)
    assert.deepEqual(f.raw(), before)
  }
})

test('only exact application ACK ends pending replay; duplicate ACK retains admission/result tombstones forever', async t => {
  const f = await fixture(t), a = admission(), r = result(a)
  await f.store.transaction(async tx => { await tx.fileWrites.reserve(a); await tx.fileWrites.retainResult(r) })
  const before = f.raw(), originalAck = ack(r)
  for (const key of ['requestId', 'sessionId', 'workerId', 'operation', 'fingerprintVersion', 'fingerprint', 'resultVersion', 'resultDigest'] as const) {
    const changed = { ...originalAck, [key]: key.endsWith('Version') ? 2 : ['fingerprint', 'resultDigest'].includes(key) ? '0'.repeat(64) : 'wrong' }
    await assert.rejects(f.store.transaction(tx => tx.fileWrites.acknowledgeResult(changed as FileWriteResultAckPayload)))
    assert.deepEqual(f.raw(), before)
  }
  await assert.rejects(f.store.transaction(tx => tx.fileWrites.acknowledgeResult({ type: 'transport.ack' } as unknown as FileWriteResultAckPayload)))
  assert.deepEqual(await f.store.fileWrites.listPendingResults(10), [r])
  await f.store.transaction(async tx => {
    const pending = tx.fileWrites.acknowledgeResult(originalAck)
    Object.assign(originalAck, { resultDigest: '0'.repeat(64) })
    await pending
  })
  await f.store.transaction(tx => tx.fileWrites.acknowledgeResult(ack(r)))
  await f.store.transaction(tx => tx.fileWrites.retainResult(r))
  assert.deepEqual(await f.store.fileWrites.listPendingResults(10), [])
  assert.deepEqual(await f.store.fileWrites.get(a.requestId), { admission: a, result: r, acknowledged: true })
  assert.deepEqual(await f.store.transaction(tx => tx.fileWrites.reserve(a)), { status: 'replay', result: r })
  assert.deepEqual(f.raw().admissions, before.admissions); assert.deepEqual(f.raw().results, before.results)
  const acknowledged = f.raw()
  f.reopen()
  assert.deepEqual(f.raw(), acknowledged)
  assert.deepEqual(await f.store.fileWrites.listPendingResults(10), [])
  assert.deepEqual(await f.store.transaction(tx => tx.fileWrites.reserve(a)), { status: 'replay', result: r })
})

test('ACK rollback retains pending delivery and duplicate ACK before a result refuses', async t => {
  const f = await fixture(t), a = admission(), r = result(a)
  await f.store.transaction(tx => tx.fileWrites.reserve(a))
  await assert.rejects(f.store.transaction(tx => tx.fileWrites.acknowledgeResult(ack(r))), /not found/)
  await f.store.transaction(tx => tx.fileWrites.retainResult(r))
  const before = f.raw()
  await assert.rejects(f.store.transaction(async tx => { await tx.fileWrites.acknowledgeResult(ack(r)); throw Error('rollback ACK') }))
  assert.deepEqual(f.raw(), before)
  assert.deepEqual(await f.store.fileWrites.listPendingResults(1), [r])
})

test('pending original result bytes survive reopen for every outcome, including unknown after ACK', async t => {
  const f = await fixture(t)
  for (const outcome of ['succeeded', 'rejected-before-effect', 'unknown'] as const) {
    const a = admission(outcome), r = result(a, outcome)
    await f.store.transaction(async tx => { await tx.fileWrites.reserve(a); await tx.fileWrites.retainResult(r) })
  }
  const before = f.raw(), pending = await f.store.fileWrites.listPendingResults(10)
  f.reopen(); assert.deepEqual(f.raw(), before)
  assert.deepEqual(await f.store.fileWrites.listPendingResults(10), pending)
  for (const r of pending) {
    const record = await f.store.fileWrites.get(r.requestId)
    assert.equal(record?.result?.resultJson, r.resultJson)
    assert.equal(record?.result?.resultDigest, r.resultDigest)
    await f.store.transaction(tx => tx.fileWrites.acknowledgeResult(ack(r)))
  }
  assert.deepEqual(await f.store.fileWrites.listPendingResults(10), [])
  assert.deepEqual(await f.store.transaction(tx => tx.fileWrites.reserve(admission('unknown'))), { status: 'unknown', result: result(admission('unknown'), 'unknown') })
})

test('normal and read-only reopen never recover; explicit exclusive-owner recovery retains unknown and cannot re-execute', async t => {
  const f = await fixture(t), a = admission()
  await f.store.transaction(tx => tx.fileWrites.reserve(a))
  const before = f.raw()
  f.reopen(true)
  assert.deepEqual(await f.store.fileWrites.get(a.requestId), { admission: a, result: null, acknowledged: false })
  assert.deepEqual(await f.store.fileWrites.listPendingResults(10), [])
  assert.deepEqual(f.raw(), before)
  f.reopen()
  assert.deepEqual(f.raw(), before)
  assert.equal((await f.store.transaction(tx => tx.fileWrites.reserve(a))).status, 'await-existing')
  assert.equal(await f.store.transaction(tx => tx.fileWrites.recoverUnresolved()), 1)
  assert.equal(await f.store.transaction(tx => tx.fileWrites.recoverUnresolved()), 0)
  const recovered = await f.store.fileWrites.get(a.requestId)
  assert.equal(recovered?.result?.outcome, 'unknown')
  assert.equal(JSON.parse(recovered!.result!.resultJson).effect, 'uncertain')
  parseFileWriteResult(recovered!.result, a)
  assert.deepEqual(await f.store.fileWrites.listPendingResults(1), [recovered!.result])
  await f.store.transaction(tx => tx.fileWrites.acknowledgeResult(ack(recovered!.result!)))
  f.reopen()
  assert.deepEqual(await f.store.transaction(tx => tx.fileWrites.reserve(a)), { status: 'unknown', result: recovered!.result })
  await assert.rejects(f.store.transaction(tx => tx.fileWrites.retainResult(result(a))), /conflict/)
  assert.deepEqual(await f.store.fileWrites.listPendingResults(1), [])
})

test('recovery rolls all unknown/results/intents back on a caught failure or outer rollback', async t => {
  const f = await fixture(t)
  for (const id of ['first', 'second']) await f.store.transaction(tx => tx.fileWrites.reserve(admission(id)))
  const before = f.raw()
  f.observer.exec(`CREATE TRIGGER inject_recovery BEFORE INSERT ON worker_file_result_delivery WHEN NEW.request_id='second' BEGIN SELECT RAISE(ABORT,'injected recovery failure'); END`)
  await f.store.transaction(async tx => { await assert.rejects(tx.fileWrites.recoverUnresolved(), /injected recovery failure/) })
  assert.deepEqual(f.raw(), before)
  f.observer.exec('DROP TRIGGER inject_recovery')
  await assert.rejects(f.store.transaction(async tx => { assert.equal(await tx.fileWrites.recoverUnresolved(), 2); throw Error('rollback recovery') }))
  assert.deepEqual(f.raw(), before)
  assert.equal(await f.store.transaction(tx => tx.fileWrites.recoverUnresolved()), 2)
  assert.equal((await f.store.fileWrites.listPendingResults(10)).length, 2)
})

test('SQL immutable insert/update/delete guards resist OR REPLACE with recursive triggers OFF', async t => {
  const f = await fixture(t), a = admission(), r = result(a)
  await f.store.transaction(async tx => { await tx.fileWrites.reserve(a); await tx.fileWrites.retainResult(r) })
  f.observer.exec('PRAGMA recursive_triggers=OFF')
  assert.equal(f.observer.prepare('PRAGMA recursive_triggers').get()!.recursive_triggers, 0)
  const before = f.raw()
  for (const [table, column, value] of [
    ['worker_file_admissions', 'admission_json', JSON.stringify({ ...a, base64Content: '' })],
    ['worker_file_results', 'result_json', JSON.stringify(result(a, 'unknown'))],
    ['worker_file_result_delivery', 'acknowledged', 1],
  ] as const) {
    assert.throws(() => f.observer.prepare(`INSERT OR REPLACE INTO ${table}(request_id,${column}) VALUES(?,?)`).run(a.requestId, value), /immutable|retained/)
    assert.throws(() => f.observer.exec(`DELETE FROM ${table}`), /retained/)
    if (table !== 'worker_file_result_delivery') assert.throws(() => f.observer.prepare(`UPDATE ${table} SET ${column}=?`).run(value), /immutable/)
    assert.throws(() => f.observer.exec(`UPDATE ${table} SET request_id='changed'`), /immutable|only permits/)
    assert.deepEqual(f.raw(), before)
  }
  await f.store.transaction(tx => tx.fileWrites.acknowledgeResult(ack(r)))
  const afterAck = f.raw()
  assert.throws(() => f.observer.exec('UPDATE worker_file_result_delivery SET acknowledged=0'), /only permits/)
  assert.throws(() => f.observer.prepare('INSERT OR REPLACE INTO worker_file_result_delivery VALUES(?,0)').run(a.requestId), /retained/)
  f.reopen()
  assert.deepEqual(f.raw(), afterAck)
  assert.deepEqual(await f.store.fileWrites.get(a.requestId), { admission: a, result: r, acknowledged: true })
})

test('schema5 upgrade appends schema7 without changing Session/queue/journal/credential state; diagnostics do not migrate', async t => {
  const f = await fixture(t), a = admission()
  await f.store.transaction(async tx => {
    await tx.sessions.createSession(a.sessionId, a.binding)
    await tx.sessions.enqueue({ sessionId: a.sessionId, submissionCommandId: 'queue-1' as never,
      message: { messageId: 'message-1' as never, content: 'preserve queue' }, queuedAt: '2026-01-01T00:00:00Z' as never })
    await tx.sessions.claimNext(a.sessionId)
    await tx.sessions.enqueue({ sessionId: a.sessionId, submissionCommandId: 'queue-2' as never,
      message: { messageId: 'message-2' as never, content: 'preserve pending' }, queuedAt: '2026-01-01T00:00:01Z' as never })
  })
  f.observer.exec(`INSERT INTO provider_credentials VALUES('synthetic-provider','model-provider','[]','enc:v2:synthetic',1,'then','then');
    INSERT INTO connector_credentials VALUES('synthetic-connector','connector','synthetic-owner','api_key','enc:v2:synthetic','{}',1,'then','then')`)
  f.close()
  // Reconstruct the immediately preceding schema by removing only the appended objects.
  const objects = f.observer.prepare("SELECT name,type FROM sqlite_master WHERE name LIKE 'worker_file_%' ORDER BY type DESC").all()
  for (const row of objects) if (row.type === 'trigger') f.observer.exec(`DROP TRIGGER ${row.name}`)
  for (const table of ['worker_file_result_delivery', 'worker_file_results', 'worker_file_admissions']) f.observer.exec(`DROP TABLE ${table}`)
  f.observer.exec('PRAGMA user_version=5')
  const snapshot = () => ({
    schema: f.observer.prepare("SELECT * FROM sqlite_master WHERE name NOT LIKE '%worker_file_%' ORDER BY name").all(),
    docs: f.observer.prepare('SELECT * FROM documents ORDER BY bucket,id').all(),
    journal: f.observer.prepare('SELECT * FROM journal').all(),
    connector: f.observer.prepare('SELECT * FROM connector_credentials').all(),
    provider: f.observer.prepare('SELECT * FROM provider_credentials').all(),
  })
  const before = snapshot()
  const diagnostic = new SqliteWorkerStore(f.path, { readOnly: true })
  assert.equal((await diagnostic.sessions.get(a.sessionId))?.sessionId, a.sessionId)
  diagnostic.close()
  assert.equal(f.observer.prepare('PRAGMA user_version').get()!.user_version, 5)
  assert.deepEqual(snapshot(), before)
  const upgraded = new SqliteWorkerStore(f.path)
  try {
    assert.equal(f.observer.prepare('PRAGMA user_version').get()!.user_version, 7)
    assert.deepEqual(snapshot(), before)
    assert.equal((await upgraded.transaction(tx => tx.fileWrites.reserve(a))).status, 'execute')
    await upgraded.transaction(tx => tx.fileWrites.retainResult(result(a)))
    assert.deepEqual(await upgraded.fileWrites.listPendingResults(1), [result(a)])
    f.observer.exec('PRAGMA recursive_triggers=OFF')
    assert.throws(() => f.observer.prepare('INSERT OR REPLACE INTO worker_file_admissions VALUES(?,?)').run(a.requestId, JSON.stringify(a)), /immutable/)
    parseFileWriteAdmit((await upgraded.fileWrites.get(a.requestId))!.admission)
  } finally { upgraded.close() }
  const bytes = f.raw()
  f.reopen()
  assert.deepEqual(f.raw(), bytes)
  assert.deepEqual(snapshot(), before)
  assert.deepEqual(await f.store.transaction(tx => tx.fileWrites.reserve(a)), { status: 'replay', result: result(a) })
})

test('file retention does not weaken Session queue/Journal lifecycle and survives Session deletion', async t => {
  const f = await fixture(t), a = admission(), r = result(a)
  const commandId = 'queued-command' as import('@wemux/domain').CommandId
  await f.store.transaction(async tx => {
    await tx.sessions.createSession(a.sessionId, a.binding)
    await tx.fileWrites.reserve(a)
    await tx.sessions.enqueue({ sessionId: a.sessionId, submissionCommandId: commandId,
      message: { messageId: 'queued-message' as never, content: 'queued' }, queuedAt: '2026-01-01T00:00:00Z' as never })
  })
  await assert.rejects(f.store.transaction(tx => tx.sessions.deleteSession(a.sessionId)), /active/)
  const turn = await f.store.transaction(tx => tx.sessions.claimNext(a.sessionId))
  assert.ok(turn)
  await assert.rejects(f.store.transaction(tx => tx.sessions.deleteSession(a.sessionId)), /active/)
  await f.store.transaction(async tx => {
    await tx.sessions.finishTurn({ turnId: turn.id, outcome: 'completed', finishedAt: '2026-01-01T00:00:01Z' as never })
    await tx.fileWrites.retainResult(r)
  })
  const page = await f.store.journal.read({ sessionId: a.sessionId, fromSeq: 1 as never, limit: 100 })
  assert.deepEqual(page.events.map(event => event.seq), page.events.map((_, index) => index + 1))
  assert.equal(page.events.filter(event => event.payload.kind === 'turn.finished').length, 1)
  await f.store.transaction(tx => tx.sessions.deleteSession(a.sessionId))
  assert.equal(await f.store.sessions.get(a.sessionId), null)
  assert.deepEqual(await f.store.journal.listHeads(), [])
  assert.deepEqual(await f.store.fileWrites.listPendingResults(10), [r])
  f.reopen()
  await assert.rejects(f.store.transaction(tx => tx.sessions.createSession(a.sessionId, a.binding)), /deleted/)
  assert.deepEqual(await f.store.transaction(tx => tx.fileWrites.reserve(a)), { status: 'replay', result: r })
})

test('explicit rowid replacement cannot erase an unresolved admission and grant a second execute', async t => {
  const f = await fixture(t), a = admission(), other = admission('different-valid-id')
  await f.store.transaction(tx => tx.fileWrites.reserve(a))
  f.observer.exec('PRAGMA recursive_triggers=OFF; PRAGMA foreign_keys=ON')
  const rowid = f.observer.prepare('SELECT rowid FROM worker_file_admissions WHERE request_id=?').get(a.requestId)!.rowid
  const before = f.raw()
  let rejected = false
  try {
    f.observer.prepare('INSERT OR REPLACE INTO worker_file_admissions(rowid,request_id,admission_json) VALUES(?,?,?)')
      .run(rowid!, other.requestId, JSON.stringify(other))
  } catch { rejected = true }
  const duplicate = await f.store.transaction(tx => tx.fileWrites.reserve(a))
  assert.equal(duplicate.status, 'await-existing', 'original reservation must not grant a second execute')
  assert.equal(rejected, true)
  assert.deepEqual(f.raw(), before)
})

const fileTables = ['worker_file_admissions', 'worker_file_results', 'worker_file_result_delivery'] as const
function rawFileRows(db: DatabaseSync) {
  return fileTables.map(table => db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all())
}
function restoreSchema6(db: DatabaseSync) {
  for (const table of fileTables) for (const suffix of ['no_replace', 'no_sentinel', 'no_update']) {
    db.exec(`DROP TRIGGER ${table}_rowid_${suffix}`)
  }
  db.exec('PRAGMA user_version=6')
}

test('rowid aliases cannot replace or move admission, result or delivery rows; automatic insertion order and ACK remain legal', async t => {
  const f = await fixture(t)
  const first = admission('first-row'), second = admission('second-row'), third = admission('third-row')
  await f.store.transaction(async tx => {
    for (const a of [first, second]) { await tx.fileWrites.reserve(a); await tx.fileWrites.retainResult(result(a)) }
    await tx.fileWrites.reserve(third)
  })
  f.observer.exec('PRAGMA recursive_triggers=OFF')
  const before = rawFileRows(f.observer)
  for (const foreignKeys of ['OFF', 'ON']) {
    f.observer.exec(`PRAGMA foreign_keys=${foreignKeys}`)
    for (const alias of ['rowid', '_rowid_', 'oid']) {
      for (const [table, column, id, value] of [
        ['worker_file_admissions', 'admission_json', 'new-admission', JSON.stringify(admission('new-admission'))],
        ['worker_file_results', 'result_json', third.requestId, JSON.stringify(result(third))],
        ['worker_file_result_delivery', 'acknowledged', second.requestId, 0],
      ] as const) {
        const rowid = f.observer.prepare(`SELECT rowid FROM ${table} WHERE request_id=?`).get(first.requestId)!.rowid!
        assert.throws(() => f.observer.prepare(`INSERT OR REPLACE INTO ${table}(${alias},request_id,${column}) VALUES(?,?,?)`).run(rowid, id, value), /rowid is immutable/)
        assert.throws(() => f.observer.prepare(`UPDATE ${table} SET ${alias}=1000 WHERE request_id=?`).run(first.requestId), /immutable/)
        assert.throws(() => f.observer.prepare(`UPDATE OR REPLACE ${table} SET ${alias}=? WHERE request_id=?`).run(rowid, second.requestId), /immutable/)
        assert.deepEqual(rawFileRows(f.observer), before)
      }
    }
  }
  await f.store.transaction(tx => tx.fileWrites.retainResult(result(third)))
  assert.deepEqual((await f.store.fileWrites.listPendingResults(10)).map(r => r.requestId), [first.requestId, second.requestId, third.requestId])
  await f.store.transaction(tx => tx.fileWrites.acknowledgeResult(ack(result(first))))
  assert.deepEqual((await f.store.fileWrites.listPendingResults(10)).map(r => r.requestId), [second.requestId, third.requestId])
  assert.deepEqual(f.observer.prepare('PRAGMA foreign_key_check').all(), [])
})

test('reserved rowid -1 inserts abort atomically without poisoning subsequent automatic allocation', async t => {
  const f = await fixture(t), a = admission('sentinel'), normal = admission('normal-after-sentinel')
  f.observer.exec('PRAGMA recursive_triggers=OFF; PRAGMA foreign_keys=ON')
  const empty = rawFileRows(f.observer)
  assert.throws(() => f.observer.prepare('INSERT INTO worker_file_admissions(rowid,request_id,admission_json) VALUES(-1,?,?)').run(a.requestId, JSON.stringify(a)), /rowid -1 is reserved/)
  assert.deepEqual(rawFileRows(f.observer), empty)
  await f.store.transaction(tx => tx.fileWrites.reserve(a))
  const reserved = rawFileRows(f.observer)
  assert.throws(() => f.observer.prepare('INSERT INTO worker_file_results(rowid,request_id,result_json) VALUES(-1,?,?)').run(a.requestId, JSON.stringify(result(a))), /rowid -1 is reserved/)
  assert.deepEqual(rawFileRows(f.observer), reserved)
  // Isolate direct delivery insertion without its normal result INSERT producer.
  // All temporary fixture changes are rolled back, including trigger removal.
  f.observer.exec('SAVEPOINT delivery_sentinel_fixture; DROP TRIGGER worker_file_result_delivery_insert')
  try {
    f.observer.prepare('INSERT INTO worker_file_results(request_id,result_json) VALUES(?,?)').run(a.requestId, JSON.stringify(result(a)))
    const before = rawFileRows(f.observer)
    assert.throws(() => f.observer.prepare('INSERT INTO worker_file_result_delivery(rowid,request_id,acknowledged) VALUES(-1,?,0)').run(a.requestId), /rowid -1 is reserved/)
    assert.deepEqual(rawFileRows(f.observer), before)
  } finally { f.observer.exec('ROLLBACK TO delivery_sentinel_fixture; RELEASE delivery_sentinel_fixture') }
  await f.store.transaction(async tx => {
    await tx.fileWrites.retainResult(result(a))
    await tx.fileWrites.reserve(normal)
    await tx.fileWrites.retainResult(result(normal))
  })
  assert.deepEqual(await f.store.fileWrites.listPendingResults(10), [result(a), result(normal)])
  assert.deepEqual(f.observer.prepare('PRAGMA foreign_key_check').all(), [])
})

test('schema6 reopen installs only appended rowid guards, preserves bytes/order and leaves unresolved reservations unresolved', async t => {
  const f = await fixture(t), a = admission('unresolved'), b = admission('pending'), c = admission('acknowledged')
  await f.store.transaction(async tx => {
    for (const item of [a, b, c]) await tx.fileWrites.reserve(item)
    await tx.fileWrites.retainResult(result(b))
    await tx.fileWrites.retainResult(result(c))
    await tx.fileWrites.acknowledgeResult(ack(result(c)))
  })
  f.close(); restoreSchema6(f.observer)
  const before = rawFileRows(f.observer)
  const schema = f.observer.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all()
  const diagnostic = new SqliteWorkerStore(f.path, { readOnly: true })
  assert.equal((await diagnostic.fileWrites.get(a.requestId))?.result, null)
  diagnostic.close()
  assert.equal(f.observer.prepare('PRAGMA user_version').get()!.user_version, 6)
  assert.deepEqual(f.observer.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), schema)
  for (let reopen = 0; reopen < 2; reopen++) {
    f.reopen()
    assert.equal(f.observer.prepare('PRAGMA user_version').get()!.user_version, 7)
    for (const object of schema) assert.deepEqual(f.observer.prepare('SELECT name,sql FROM sqlite_master WHERE name=?').get(object.name!), object)
    assert.deepEqual(rawFileRows(f.observer), before)
    assert.equal((await f.store.transaction(tx => tx.fileWrites.reserve(a))).status, 'await-existing')
    assert.deepEqual(await f.store.fileWrites.listPendingResults(10), [result(b)])
    f.observer.exec('PRAGMA recursive_triggers=OFF')
    const rowid = f.observer.prepare('SELECT rowid FROM worker_file_admissions WHERE request_id=?').get(a.requestId)!.rowid!
    assert.throws(() => f.observer.prepare('INSERT OR REPLACE INTO worker_file_admissions(rowid,request_id,admission_json) VALUES(?,?,?)').run(rowid, 'new-id', JSON.stringify(admission('new-id'))), /rowid is immutable/)
    assert.deepEqual(rawFileRows(f.observer), before)
  }
  const d = admission('new-after-upgrade')
  await f.store.transaction(async tx => { await tx.fileWrites.reserve(d); await tx.fileWrites.retainResult(result(d)) })
  assert.deepEqual(await f.store.fileWrites.listPendingResults(10), [result(b), result(d)])
  await f.store.transaction(tx => tx.fileWrites.acknowledgeResult(ack(result(d))))
  const afterAck = rawFileRows(f.observer)
  f.reopen()
  assert.deepEqual(rawFileRows(f.observer), afterAck)
  assert.deepEqual(await f.store.fileWrites.listPendingResults(10), [result(b)])
})

for (const table of fileTables) test(`schema6 migration refuses legacy reserved rowid in ${table} without changing schema or bytes`, async t => {
  const f = await fixture(t), a = admission('legacy-sentinel')
  f.close(); restoreSchema6(f.observer)
  f.observer.prepare(`INSERT INTO worker_file_admissions(${table === 'worker_file_admissions' ? 'rowid,' : ''}request_id,admission_json) VALUES(${table === 'worker_file_admissions' ? '-1,' : ''}?,?)`).run(a.requestId, JSON.stringify(a))
  if (table !== 'worker_file_admissions') {
    f.observer.prepare(`INSERT INTO worker_file_results(${table === 'worker_file_results' ? 'rowid,' : ''}request_id,result_json) VALUES(${table === 'worker_file_results' ? '-1,' : ''}?,?)`).run(a.requestId, JSON.stringify(result(a)))
    if (table === 'worker_file_result_delivery') f.observer.exec('UPDATE worker_file_result_delivery SET rowid=-1')
  }
  const snapshot = () => ({ rows: rawFileRows(f.observer), schema: f.observer.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), version: f.observer.prepare('PRAGMA user_version').get() })
  const before = snapshot()
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => new SqliteWorkerStore(f.path), { message: `Worker schema 7 migration refused: ${table} contains reserved rowid -1` })
    assert.deepEqual(snapshot(), before)
  }
  const diagnostic = new SqliteWorkerStore(f.path, { readOnly: true })
  assert.deepEqual((await diagnostic.fileWrites.get(a.requestId))?.admission, a)
  diagnostic.close()
  assert.deepEqual(snapshot(), before)
})

test('out-of-band schema6 max rowid -2 may open but reserved automatic -1 allocation fails without execute authority', async t => {
  const f = await fixture(t), a = admission('external-negative-row'), b = admission('would-allocate-sentinel')
  f.close(); restoreSchema6(f.observer)
  f.observer.prepare('INSERT INTO worker_file_admissions(rowid,request_id,admission_json) VALUES(-2,?,?)').run(a.requestId, JSON.stringify(a))
  const before = rawFileRows(f.observer)
  f.reopen()
  assert.equal(f.observer.prepare('PRAGMA user_version').get()!.user_version, 7)
  await assert.rejects(f.store.transaction(tx => tx.fileWrites.reserve(b)), /rowid -1 is reserved/)
  assert.deepEqual(rawFileRows(f.observer), before)
  assert.equal(await f.store.fileWrites.get(b.requestId), null)
  assert.equal((await f.store.transaction(tx => tx.fileWrites.reserve(a))).status, 'await-existing')
})
