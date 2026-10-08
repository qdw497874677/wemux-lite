import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setImmediate } from 'node:timers/promises'
import type { AgentKey, ProjectId, SessionId, TeamId, Timestamp, UserId, WorkerId, WorkspaceId } from '@wemux/domain'
import { TaskService } from '../application/task-service.ts'
import { SessionAccessService } from '../application/session-access-service.ts'
import { ProjectAccessService } from '../application/project-access-service.ts'
import type { FileWriteResultPayload, FileWriteOutcome } from '@wemux/wire-protocol'
import { computeFileWriteFingerprint, computeFileWriteResultDigest, parseFileWriteResultAck } from '@wemux/wire-protocol/file-admission-node'
import type { FileWriteAdmission } from '../application/ports/file-write-admission.ts'
import type { ServerStore, ServerStoreTx } from '../application/ports/server-store.ts'
import { ServerService } from '../application/server-service.ts'
import { FileWriteResultRejectedError, FileWriteResultUnavailableError } from '../application/file-write-results.ts'
import { Notifications } from '../application/notifications.ts'
import { SqliteServerStore } from '../storage/sqlite/store.ts'
import { migrationCount } from '../storage/sqlite/migrations.ts'
import { runInvariants } from '../storage/sqlite/run-invariants.ts'

const worker = 'worker' as WorkerId
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function admission(id = 'admission'): FileWriteAdmission {
  const value = { admissionId: id, actorId: 'actor' as UserId, sessionId: 'session' as SessionId, requestId: `client-${id}`, operation: 'fs.write' as const, workerId: worker,
    binding: { workspaceId: 'workspace' as WorkspaceId, agent: { workerId: worker, agentKey: 'agent' as AgentKey }, modelId: null },
    subpath: 'folder/你好.txt', base64Content: 'YQ==', fingerprintVersion: 1 as const, admittedAt: '2026-01-01T00:00:00.000Z' as Timestamp }
  return { ...value, fingerprint: computeFileWriteFingerprint({ ...value, clientRequestId: value.requestId }) }
}
function result(a: FileWriteAdmission, outcome: FileWriteOutcome = 'succeeded'): FileWriteResultPayload {
  const value = { type: 'fs.write.result' as const, requestId: a.admissionId, sessionId: a.sessionId, workerId: a.workerId, operation: a.operation, fingerprintVersion: a.fingerprintVersion, fingerprint: a.fingerprint, resultVersion: 1 as const, outcome,
    resultJson: JSON.stringify(outcome === 'succeeded' ? { ok: true, operation: 'write', subpath: a.subpath, size: 1 } : { ok: false, operation: 'write', effect: outcome === 'unknown' ? 'uncertain' : 'not-started', error: '保留原始结果' }) }
  return { ...value, resultDigest: computeFileWriteResultDigest(value) }
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'server-file-results-')), path = join(directory, 'store.sqlite')
  let store = new SqliteServerStore(path)
  const observer = new DatabaseSync(path)
  observer.exec('PRAGMA recursive_triggers=OFF')
  const a = admission()
  await store.transaction(tx => tx.fileWrites.insertHeld(a))
  return { get store() { return store }, observer, a, path,
    service: () => new ServerService(store, new Notifications()),
    reopen() { store.close(); store = new SqliteServerStore(path); return store },
    close() { observer.close(); store.close(); rmSync(directory, { recursive: true, force: true }) } }
}
function wrapped(store: SqliteServerStore, transaction: ServerStore['transaction']): ServerStore {
  return { fileWrites: store.fileWrites, tasks: store.tasks, identity: store.identity, resources: store.resources, commands: store.commands, cache: store.cache, transaction }
}
const rows = (db: DatabaseSync) => db.prepare("SELECT rowid,kind,id,data FROM records WHERE kind LIKE 'file-write-%' ORDER BY rowid").all()

for (const alias of ['rowid', '_rowid_', 'oid']) test(`file records reject cross-kind OR REPLACE via ${alias} with recursive triggers OFF`, async t => {
  const f = await fixture(); t.after(() => f.close())
  const before = rows(f.observer)
  for (const row of before) {
    assert.throws(() => f.observer.prepare(`INSERT OR REPLACE INTO records(${alias},kind,id,data) VALUES(?,'unrelated','replacement','{}')`).run(row.rowid!), /immutable/)
    assert.deepEqual(rows(f.observer), before)
  }
})

for (const outcome of ['succeeded', 'rejected-before-effect', 'unknown'] as const) test(`retains ${outcome} exact bytes without Session/actor/waiter, duplicates and reopened ACK`, async t => {
  const f = await fixture(); t.after(() => f.close())
  const value = result(f.a, outcome), before = rows(f.observer)
  const ack = await f.service().receiveFileWriteResult(worker, value)
  assert.deepEqual(parseFileWriteResultAck(ack, value), ack)
  assert.deepEqual(await f.store.fileWrites.getResult(f.a.admissionId), value)
  assert.deepEqual(await f.store.fileWrites.getIntent(f.a.admissionId), { admissionId: f.a.admissionId, state: 'held' })
  assert.deepEqual(rows(f.observer).filter(row => row.kind !== 'file-write-result'), before)
  const retainedBytes = rows(f.observer)
  // Property order is not result identity; resultJson itself must remain exact.
  const reordered = Object.fromEntries(Object.entries(value).reverse())
  assert.deepEqual(await f.service().receiveFileWriteResult(worker, reordered), ack)
  const duplicates = await Promise.all(Array.from({ length: 20 }, () => f.service().receiveFileWriteResult(worker, value)))
  for (const duplicate of duplicates) assert.deepEqual(duplicate, ack)
  assert.deepEqual(rows(f.observer), retainedBytes)
  f.reopen()
  assert.deepEqual(await f.store.fileWrites.getResult(f.a.admissionId), value)
  assert.deepEqual(await f.service().receiveFileWriteResult(worker, value), ack)
  assert.deepEqual(rows(f.observer), retainedBytes)
  const read = (await f.store.fileWrites.getResult(f.a.admissionId))! as { resultJson: string }
  read.resultJson = 'mutated reader result'
  assert.deepEqual(await f.store.fileWrites.getResult(f.a.admissionId), value)
  const conflict = result(f.a, outcome === 'unknown' ? 'succeeded' : 'unknown')
  await assert.rejects(f.service().receiveFileWriteResult(worker, conflict), /Conflicting/)
  assert.deepEqual(rows(f.observer), retainedBytes)
})

test('receiver and repository deny cross-worker/admission/Session/operation/fingerprint/version/digest and malformed bytes before mutation', async t => {
  const f = await fixture(); t.after(() => f.close())
  const valid = result(f.a), before = rows(f.observer)
  const second = admission('second')
  await f.store.transaction(tx => tx.fileWrites.insertHeld(second))
  const baseline = rows(f.observer)
  const variants: unknown[] = [null, [], {}, { ...valid, extra: true }, { ...valid, type: 'fs.write.result.ack' },
    { ...valid, requestId: 'absent' }, { ...valid, sessionId: 'other' }, { ...valid, workerId: 'other' },
    { ...valid, operation: 'fs.read' }, { ...valid, fingerprintVersion: 2 }, { ...valid, resultVersion: 2 },
    { ...valid, fingerprint: '0'.repeat(64) }, { ...valid, resultDigest: '0'.repeat(64) },
    { ...valid, resultJson: 'not json' }, { ...valid, resultJson: ' ' + valid.resultJson },
    { ...valid, resultJson: '{"ok":true,"ok":true,"operation":"write","subpath":"folder/你好.txt","size":1}' },
    { ...valid, outcome: 'unknown' }]
  for (const patch of [{ requestId: second.admissionId }, { sessionId: 'other' as SessionId }, { workerId: 'other' as WorkerId }, { fingerprint: 'a'.repeat(64) },
    { resultJson: JSON.stringify({ ok: true, operation: 'write', subpath: 'wrong.txt', size: 1 }) },
    { resultJson: JSON.stringify({ ok: true, operation: 'write', subpath: f.a.subpath, size: 2 }) }]) {
    const value = { ...valid, ...patch }; variants.push({ ...value, resultDigest: computeFileWriteResultDigest(value) })
  }
  for (const value of variants) {
    await assert.rejects(f.service().receiveFileWriteResult(worker, value))
    await assert.rejects(f.store.transaction(tx => tx.fileWrites.retainResult(worker, value)))
    assert.deepEqual(rows(f.observer), baseline)
  }
  await assert.rejects(f.service().receiveFileWriteResult('other' as WorkerId, valid), /authenticated Worker/)
  await assert.rejects(f.store.transaction(tx => tx.fileWrites.retainResult('' as WorkerId, valid)), /authenticated Worker/)
  assert.equal(await f.store.fileWrites.getResult(f.a.admissionId), null)
  await f.service().receiveFileWriteResult(worker, valid)
  const retained = rows(f.observer)
  await assert.rejects(f.service().receiveFileWriteResult('other' as WorkerId, valid), /authenticated Worker/)
  assert.deepEqual(rows(f.observer), retained)
  assert.deepEqual(retained.filter(row => row.id === f.a.admissionId && row.kind !== 'file-write-result'), before)
})

test('stored admission is verified, including old incompatible wire IDs and tampered fingerprint, without rewriting it', async t => {
  const f = await fixture(); t.after(() => f.close())
  for (const a of [{ ...admission('bad-fingerprint'), fingerprint: '0'.repeat(64) }, { ...admission('bad-wire'), actorId: 'actor\u0001' as UserId }]) {
    await f.store.transaction(tx => tx.fileWrites.insertHeld(a))
    const before = rows(f.observer)
    await assert.rejects(f.service().receiveFileWriteResult(worker, result(a)))
    assert.deepEqual(rows(f.observer), before)
  }
})

test('snapshots caller before waiting in committed transaction FIFO', async t => {
  const f = await fixture(); t.after(() => f.close())
  const entered = deferred(), release = deferred()
  const blocker = f.store.transaction(async () => { entered.resolve(); await release.promise })
  await entered.promise
  const value = result(f.a), expected = { ...value }
  const pending = f.service().receiveFileWriteResult(worker, value)
  Object.assign(value, { workerId: 'other', requestId: 'other', resultDigest: '0'.repeat(64), resultJson: 'mutated' })
  release.resolve(); await blocker
  assert.deepEqual(parseFileWriteResultAck(await pending, expected).resultDigest, expected.resultDigest)
  assert.deepEqual(await f.store.fileWrites.getResult(f.a.admissionId), expected)
})

test('independent observer, committed-reader FIFO, ACK-after-commit and escaped transaction leases', async t => {
  const f = await fixture(); t.after(() => f.close())
  const inserted = deferred(), release = deferred()
  let escaped!: ServerStoreTx['fileWrites'], captured!: ServerStoreTx['fileWrites']['retainResult']
  const value = result(f.a)
  const store = wrapped(f.store, work => f.store.transaction(async tx => {
    escaped = tx.fileWrites; captured = tx.fileWrites.retainResult
    const retained = await work(tx)
    assert.deepEqual(await tx.fileWrites.getResult(f.a.admissionId), value)
    await assert.rejects(f.store.fileWrites.getResult(f.a.admissionId), /tx readers/)
    inserted.resolve(); await release.promise
    return retained
  }))
  let ackReturned = false
  const receive = new ServerService(store, new Notifications()).receiveFileWriteResult(worker, value).then(ack => {
    ackReturned = true
    assert.equal(f.observer.prepare("SELECT count(*) n FROM records WHERE kind='file-write-result'").get()!.n, 1)
    return ack
  })
  await inserted.promise
  assert.equal(f.observer.prepare("SELECT count(*) n FROM records WHERE kind='file-write-result'").get()!.n, 0)
  let readReturned = false
  const read = f.store.fileWrites.getResult(f.a.admissionId).then(row => { readReturned = true; return row })
  await setImmediate()
  assert.equal(readReturned, false); assert.equal(ackReturned, false)
  release.resolve(); await receive
  assert.deepEqual(await read, value)
  for (const use of [() => escaped.getResult(f.a.admissionId), () => captured(worker, value)]) {
    await assert.rejects(use(), /no longer active/)
    await f.store.transaction(async () => { await assert.rejects(use(), /no longer active/) })
  }
})

test('outer rollback, SQL failure and failed COMMIT never return application ACK', async t => {
  const f = await fixture(); t.after(() => f.close())
  const value = result(f.a), before = rows(f.observer)
  let escaped!: ServerStoreTx['fileWrites']
  const rollbackStore = wrapped(f.store, work => f.store.transaction(async tx => {
    escaped = tx.fileWrites
    await work(tx)
    throw new Error('rollback after retention')
  }))
  await assert.rejects(new ServerService(rollbackStore, new Notifications()).receiveFileWriteResult(worker, value), error => error instanceof FileWriteResultUnavailableError && error.cause instanceof Error && /rollback after retention/.test(error.cause.message))
  await assert.rejects(escaped.retainResult(worker, value), /no longer active/)
  assert.deepEqual(rows(f.observer), before)
  f.observer.exec(`CREATE TRIGGER fail_file_result BEFORE INSERT ON records WHEN NEW.kind='file-write-result' BEGIN SELECT RAISE(ABORT,'result failure'); END`)
  await assert.rejects(f.service().receiveFileWriteResult(worker, value), error => error instanceof FileWriteResultUnavailableError && error.cause instanceof Error && /result failure/.test(error.cause.message))
  f.observer.exec('DROP TRIGGER fail_file_result')
  assert.deepEqual(rows(f.observer), before)
  // A deferred foreign key failure rejects the actual COMMIT, not only the callback.
  f.observer.exec('CREATE TABLE result_commit_probe (parent INTEGER REFERENCES result_commit_probe(rowid_key) DEFERRABLE INITIALLY DEFERRED, rowid_key INTEGER PRIMARY KEY)')
  f.observer.exec(`CREATE TRIGGER fail_result_commit AFTER INSERT ON records WHEN NEW.kind='file-write-result' BEGIN INSERT INTO result_commit_probe(parent) VALUES(999); END`)
  await assert.rejects(f.service().receiveFileWriteResult(worker, value), error => error instanceof FileWriteResultUnavailableError && error.cause instanceof Error && /FOREIGN KEY/.test(error.cause.message))
  assert.deepEqual(rows(f.observer), before)
  assert.equal(f.observer.prepare('SELECT count(*) n FROM result_commit_probe').get()!.n, 0)
  f.observer.exec('DROP TRIGGER fail_result_commit; DROP TABLE result_commit_probe')
  assert.equal(await f.store.fileWrites.getResult(f.a.admissionId), null)
  assert.deepEqual(parseFileWriteResultAck(await f.service().receiveFileWriteResult(worker, value), value).resultDigest, value.resultDigest)
})

test('raw SQLite result logical identity/update/delete and all protected rowid aliases resist replacement', async t => {
  const f = await fixture(); t.after(() => f.close())
  await f.service().receiveFileWriteResult(worker, result(f.a))
  const before = rows(f.observer)
  f.observer.exec("INSERT INTO records(kind,id,data) VALUES('unrelated','movable','{}')")
  for (const row of before) {
    for (const alias of ['rowid', '_rowid_', 'oid']) {
      for (const sql of [
        `INSERT OR REPLACE INTO records(${alias},kind,id,data) VALUES(?,'unrelated','replacement','{}')`,
        `REPLACE INTO records(${alias},kind,id,data) VALUES(?,'unrelated','replacement','{}')`,
        `UPDATE OR REPLACE records SET ${alias}=? WHERE kind='unrelated' AND id='movable'`,
      ]) assert.throws(() => f.observer.prepare(sql).run(row.rowid!), /immutable/)
      assert.throws(() => f.observer.prepare(`UPDATE records SET ${alias}=${alias}+1000 WHERE kind=? AND id=?`).run(row.kind!, row.id!), /immutable/)
      // Same-kind replacement with changed identity must fail too.
      const data = JSON.parse(String(row.data))
      if (row.kind === 'file-write-result') data.requestId = 'other'
      else data.admissionId = 'other'
      assert.throws(() => f.observer.prepare(`INSERT OR REPLACE INTO records(${alias},kind,id,data) VALUES(?,?,?,?)`).run(row.rowid!, row.kind!, 'other', JSON.stringify(data)))
    }
    for (const sql of ["UPDATE records SET data='{}' WHERE kind=? AND id=?", "UPDATE records SET kind='unrelated',id='changed' WHERE kind=? AND id=?", 'DELETE FROM records WHERE kind=? AND id=?']) {
      assert.throws(() => f.observer.prepare(sql).run(row.kind!, row.id!), /immutable/)
    }
    assert.throws(() => f.observer.prepare('INSERT OR REPLACE INTO records(kind,id,data) VALUES(?,?,?)').run(row.kind!, row.id!, row.data!), /immutable/)
    assert.deepEqual(rows(f.observer), before)
  }
  f.reopen()
  assert.deepEqual(rows(f.observer), before)
})

test('rowid sentinel guards run after automatic allocation; unrelated -1 remains legal', async t => {
  const f = await fixture(); t.after(() => f.close())
  // Directly demonstrate SQLite NEW.rowid=-1 before allocation, positive afterward.
  f.observer.exec(`CREATE TABLE rowid_probe(value TEXT); CREATE TABLE rowid_seen(phase TEXT,id INTEGER);
    CREATE TRIGGER probe_before BEFORE INSERT ON rowid_probe BEGIN INSERT INTO rowid_seen VALUES('before',NEW.rowid); END;
    CREATE TRIGGER probe_after AFTER INSERT ON rowid_probe BEGIN INSERT INTO rowid_seen VALUES('after',NEW.rowid); END;
    INSERT INTO rowid_probe(value) VALUES('automatic');`)
  assert.deepEqual(f.observer.prepare('SELECT phase,id FROM rowid_seen ORDER BY rowid').all().map(row => [row.phase, row.id]), [['before', -1], ['after', 1]])
  const next = admission('sentinel')
  const before = rows(f.observer)
  assert.throws(() => f.observer.prepare("INSERT INTO records(rowid,kind,id,data) VALUES(-1,'file-write-admission',?,?)").run(next.admissionId, JSON.stringify(next)), /reserved/)
  assert.deepEqual(rows(f.observer), before, 'admission AFTER INSERT held-intent side effect must roll back too')
  assert.throws(() => f.observer.prepare("INSERT INTO records(rowid,kind,id,data) VALUES(-1,'file-write-result',?,?)").run(f.a.admissionId, JSON.stringify(result(f.a))), /reserved/)
  f.observer.exec("INSERT INTO records(rowid,kind,id,data) VALUES(-1,'unrelated','negative','{}')")
  await f.store.transaction(tx => tx.fileWrites.insertHeld(next))
  await f.service().receiveFileWriteResult(worker, result(next))
  assert.equal(f.observer.prepare("SELECT rowid FROM records WHERE kind='unrelated' AND id='negative'").get()!.rowid, -1)
  f.reopen()
  assert.deepEqual(await f.store.fileWrites.getResult(next.admissionId), result(next))
})

const schema = (db: DatabaseSync) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
const versions = (db: DatabaseSync) => db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
function removeResultMigration(db: DatabaseSync) {
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'file_result_%'").all()) db.exec(`DROP TRIGGER ${row.name}`)
  // Restore the historical schema, not merely the latest version marker.
  for (const name of ['invalid_run_identity', 'invalid_session_source']) {
    const definition = runInvariants.match(new RegExp(`CREATE VIEW ${name} AS[\\s\\S]*?;`))?.[0]
    assert.ok(definition)
    db.exec(`DROP VIEW ${name}; ${definition}`)
  }
  db.exec('DROP TRIGGER command_rejection_no_dispatch; DROP TABLE command_rejections')
  db.exec('DROP INDEX IF EXISTS attention_failed_runs_order; DROP INDEX IF EXISTS attention_dead_letters_order; DROP INDEX IF EXISTS attention_human_reviews_order')
  db.prepare('DELETE FROM schema_migrations WHERE version>=?').run(34)
}

test('append-only schema 33 upgrade preserves complete old schema/admission/held bytes, then retains result and reopens', async t => {
  const f = await fixture(); t.after(() => f.close())
  f.store.close(); removeResultMigration(f.observer)
  const oldSchema = schema(f.observer), oldVersions = versions(f.observer), before = rows(f.observer)
  assert.equal(oldVersions.at(-1)!.version, 33)
  f.reopen()
  // v34+ 合法新增/改写的对象才允许出现在升级后的 schema 里。
  // attention_* 三个排序索引由 v39/v40 创建，v33 的旧 schema 里本来就没有，
  // 因此必须列入白名单；这不会放过任何旧对象被改写，因为旧侧不存在同名对象。
  const unchanged = (rows: ReturnType<typeof schema>) => rows.filter(row => !String(row.name).startsWith('file_result_') && !String(row.name).startsWith('command_rejection') && !String(row.name).includes('command_rejections') && !String(row.name).startsWith('attention_') && !['invalid_run_identity', 'invalid_session_source'].includes(String(row.name)))
  assert.deepEqual(unchanged(schema(f.observer)), unchanged(oldSchema))
  assert.deepEqual(versions(f.observer).filter(row => Number(row.version) <= 33), oldVersions)
  assert.equal(versions(f.observer).at(-1)!.version, migrationCount)
  assert.deepEqual(rows(f.observer), before)
  const value = result(f.a, 'unknown'), ack = await f.service().receiveFileWriteResult(worker, value)
  const next = admission('post-upgrade')
  await f.store.transaction(tx => tx.fileWrites.insertHeld(next))
  await f.service().receiveFileWriteResult(worker, result(next))
  const retained = rows(f.observer), upgradedSchema = schema(f.observer)
  f.reopen()
  assert.deepEqual(rows(f.observer), retained)
  assert.deepEqual(schema(f.observer), upgradedSchema)
  assert.deepEqual(await f.service().receiveFileWriteResult(worker, value), ack)
  assert.deepEqual(retained.filter(row => row.id === f.a.admissionId && row.kind !== 'file-write-result'), before)
})

for (const kind of ['file-write-admission', 'file-write-intent']) test(`old ${kind} at rowid -1 refuses migration without altering schema/version/bytes`, async t => {
  const f = await fixture(); t.after(() => f.close())
  f.store.close(); removeResultMigration(f.observer)
  const updateGuard = f.observer.prepare("SELECT sql FROM sqlite_master WHERE name='file_write_immutable_update'").get()!.sql
  f.observer.exec('DROP TRIGGER file_write_immutable_update')
  f.observer.prepare('UPDATE records SET rowid=-1 WHERE kind=?').run(kind)
  f.observer.exec(String(updateGuard))
  const before = rows(f.observer), oldSchema = schema(f.observer), oldVersions = versions(f.observer)
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => new SqliteServerStore(f.path), /File storage migration refuses protected rowid -1/)
    assert.deepEqual(rows(f.observer), before)
    assert.deepEqual(schema(f.observer), oldSchema)
    assert.deepEqual(versions(f.observer), oldVersions)
    assert.equal(f.observer.prepare("SELECT count(*) n FROM sqlite_temp_master WHERE name='file_result_rowid_preflight'").get()!.n, 0)
  }
})

test('receiver is restricted to internal gateway embedding, without production opt-in or browser activation', () => {
  function files(path: string): string[] {
    return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : entry.name.endsWith('.ts') ? [join(path, entry.name)] : [])
  }
  const root = new URL('..', import.meta.url).pathname
  for (const path of files(root).filter(path => !path.includes('/test/'))) {
    const source = readFileSync(path, 'utf8')
    const receiverSeams = ['/application/server-service.ts', '/worker-ws/gateway.ts', '/worker-ws/file-result-ingress.ts']
    if (!receiverSeams.some(seam => path.endsWith(seam))) assert.doesNotMatch(source, /receiveFileWriteResult/)
    if (path.includes('/http/') || /\/(main|server)\.ts$/.test(path)) {
      assert.doesNotMatch(source, /fileWrites\.getResult|fs-write-admission-v1|fs\.write\.result\.ack|ServerFileResultIngress/)
    }
    if (path.endsWith('/server.ts')) assert.ok(source.includes("new WorkerGateway(server, auth, workers, notifications, new ServerTransportStore(options.databasePath === ':memory:' ? ':memory:' : `${options.databasePath}.transport`))"))
    if (path.endsWith('/worker-ws/gateway.ts')) assert.doesNotMatch(source, /admitFileWrite|enqueueFileWriteAdmission/)

  }
})

test('post-admission actor revocation denies admission replay but does not discard historical Worker result', async t => {
  const f = await fixture(); t.after(() => f.close())
  const owner = 'owner' as UserId, actor = 'member' as UserId, teamId = 'team' as TeamId, projectId = 'project' as ProjectId
  const at = '2026-01-01T00:00:00.000Z' as Timestamp
  await f.store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Fixture', createdAt: at })
    for (const id of [owner, actor]) {
      await tx.identity.saveUser({ id, username: id, email: null, createdAt: at })
      await tx.identity.saveMembership({ teamId, userId: id, role: id === owner ? 'owner' : 'member', joinedAt: at })
    }
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: owner, name: 'Fixture', shareScope: 'team', deletedAt: null })
    await tx.identity.saveProjectGrant({ projectId, userId: actor, role: 'contributor' })
  })
  const task = await new TaskService(f.store).create(projectId, { title: 'Fixture' }, { actor: owner, requestId: 'task' })
  await f.store.transaction(tx => tx.resources.saveSession({
    id: f.a.sessionId, projectId, taskId: task.id, runId: null, ownerId: owner, workspaceId: f.a.binding.workspaceId,
    title: 'Fixture', shareScope: 'project', runtimeState: 'idle', deletedAt: null, binding: f.a.binding,
  }))
  const service = new ServerService(f.store, new Notifications(), undefined, undefined, undefined, new SessionAccessService(f.store, new ProjectAccessService(f.store)))
  const input = { requestId: 'authorized', subpath: f.a.subpath, base64Content: f.a.base64Content }
  const admitted = await service.admitFileWrite(f.a.sessionId, actor, input)
  await f.store.transaction(tx => tx.identity.saveProjectGrant({ projectId, userId: actor, role: 'viewer' }))
  await assert.rejects(service.admitFileWrite(f.a.sessionId, actor, input), { status: 403 })
  const value = result(admitted, 'unknown'), ack = await service.receiveFileWriteResult(worker, value)
  assert.deepEqual(await f.store.fileWrites.getResult(admitted.admissionId), value)
  await assert.rejects(service.admitFileWrite(f.a.sessionId, actor, input), { status: 403 })
  assert.deepEqual(await service.receiveFileWriteResult(worker, value), ack)
  assert.deepEqual(await f.store.fileWrites.getIntent(admitted.admissionId), { admissionId: admitted.admissionId, state: 'held' })
})

test('queued committed reader sees null after rollback; direct repository snapshots before yielding', async t => {
  const f = await fixture(); t.after(() => f.close())
  const value = result(f.a), expected = { ...value }, inserted = deferred(), release = deferred()
  const transaction = f.store.transaction(async tx => {
    const write = tx.fileWrites.retainResult(worker, value)
    Object.assign(value, { resultJson: 'mutated', fingerprint: '0'.repeat(64) })
    assert.deepEqual(await write, expected)
    inserted.resolve(); await release.promise
    throw new Error('rollback queued read')
  })
  const rejection = assert.rejects(transaction, /rollback queued read/)
  await inserted.promise
  let returned = false
  const reader = f.store.fileWrites.getResult(f.a.admissionId).then(row => { returned = true; return row })
  await setImmediate(); assert.equal(returned, false)
  assert.equal(f.observer.prepare("SELECT count(*) n FROM records WHERE kind='file-write-result'").get()!.n, 0)
  release.resolve(); await rejection
  assert.equal(await reader, null)
  f.reopen()
  assert.equal(await f.store.fileWrites.getResult(f.a.admissionId), null)
})


test('receiver intentional validation and committed conflicts remain explicitly permanent', async t => {
  const f = await fixture(); t.after(() => f.close()); const value = result(f.a)
  for (const [id, input] of [
    [worker, { ...value, unexpected: true }],
    ['other' as WorkerId, value],
    [worker, { ...value, resultDigest: '0'.repeat(64) }],
    [worker, { ...value, requestId: 'missing' }],
  ] as const) await assert.rejects(f.service().receiveFileWriteResult(id, input), FileWriteResultRejectedError)
  await f.service().receiveFileWriteResult(worker, result(f.a, 'unknown'))
  await assert.rejects(f.service().receiveFileWriteResult(worker, value), FileWriteResultRejectedError)
})
