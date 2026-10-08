import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setImmediate } from 'node:timers/promises'
import type { AgentKey, ModelId, ProjectId, SessionId, TeamId, UserId, WorkerId, WorkspaceId } from '@wemux/domain'
import type { Session } from '@wemux/server-domain'
import { ServerService, now } from '../application/server-service.ts'
import { Notifications } from '../application/notifications.ts'
import { ProjectAccessService } from '../application/project-access-service.ts'
import { SessionAccessService } from '../application/session-access-service.ts'
import { TaskService } from '../application/task-service.ts'
import type { ServerStore, ServerStoreTx } from '../application/ports/server-store.ts'
import type { FileWriteAdmission } from '../application/ports/file-write-admission.ts'
import { SqliteServerStore } from '../storage/sqlite/store.ts'
import { migrationCount } from '../storage/sqlite/migrations.ts'

const owner = 'owner' as UserId, member = 'member' as UserId, admin = 'admin' as UserId
const teamId = 'team' as TeamId, projectId = 'project' as ProjectId, sessionId = 'session' as SessionId
const input = () => ({ requestId: 'request', subpath: 'folder/file.txt', base64Content: 'YQ==' })
const makeService = (store: ServerStore) => new ServerService(store, new Notifications(), undefined, undefined, undefined, new SessionAccessService(store, new ProjectAccessService(store)))
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'server-file-admission-')), path = join(directory, 'store.sqlite')
  const store = new SqliteServerStore(path), observer = new DatabaseSync(path)
  const at = now()
  await store.transaction(async tx => {
    await tx.identity.saveTeam({ id: teamId, name: 'Fixture', createdAt: at })
    for (const id of [owner, member, admin]) {
      await tx.identity.saveUser({ id, username: id, email: null, createdAt: at })
      await tx.identity.saveMembership({ teamId, userId: id, role: id === owner ? 'owner' : 'member', joinedAt: at })
    }
    await tx.identity.saveInstanceAdministrator({ userId: admin, email: 'admin@example.test', assignedAt: at, source: 'declared' })
    await tx.resources.saveProject({ id: projectId, teamId, ownerId: owner, name: 'Fixture', shareScope: 'team', deletedAt: null })
    for (const id of [member, admin]) await tx.identity.saveProjectGrant({ projectId, userId: id, role: 'contributor' })
  })
  const task = await new TaskService(store).create(projectId, { title: 'Fixture' }, { actor: owner, requestId: 'task' })
  const session: Session = {
    id: sessionId, projectId, taskId: task.id, runId: null, ownerId: owner, workspaceId: 'workspace' as WorkspaceId, title: 'Fixture', shareScope: 'project', runtimeState: 'idle', deletedAt: null,
    binding: { workspaceId: 'workspace' as WorkspaceId, agent: { workerId: 'worker' as WorkerId, agentKey: 'agent' as AgentKey }, modelId: 'model' as ModelId },
  }
  await store.transaction(tx => tx.resources.saveSession(session))
  const service = makeService(store)
  const updateSession = (update: Partial<Session>) => store.transaction(async tx => tx.resources.saveSession({ ...(await tx.resources.getSession(sessionId))!, ...update }))
  const role = (role: 'viewer' | 'contributor' | 'manager') => store.transaction(tx => tx.identity.saveProjectGrant({ projectId, userId: member, role }))
  const counts = () => observer.prepare("SELECT kind,count(*) AS count FROM records WHERE kind IN ('file-write-admission','file-write-intent') GROUP BY kind ORDER BY kind").all().map(row => [row.kind, Number(row.count)])
  return { store, observer, path, task, session, service, updateSession, role, counts, close() { observer.close(); store.close(); rmSync(directory, { recursive: true, force: true }) } }
}

function intercepted(store: SqliteServerStore, intercept: (tx: ServerStoreTx) => ServerStoreTx): ServerStore {
  return { fileWrites: store.fileWrites, tasks: store.tasks, resources: store.resources, identity: store.identity, commands: store.commands, cache: store.cache, transaction: work => store.transaction(tx => work(intercept(tx))) }
}

test('file admission requires explicit actor and configured Session authorization; private visibility before body validation', async t => {
  const f = await fixture(); t.after(() => f.close())
  await assert.rejects(f.service.admitFileWrite(sessionId, undefined as unknown as UserId, input()), { status: 401 })
  const legacy = new ServerService(f.store, new Notifications())
  await assert.rejects(legacy.admitFileWrite(sessionId, owner, input()), { status: 403 })
  for (const row of [
    { actor: owner, scope: 'owner-only', role: 'viewer', status: 200 },
    { actor: member, scope: 'project', role: 'viewer', status: 403 },
    { actor: member, scope: 'project', role: 'contributor', status: 200 },
    { actor: member, scope: 'project', role: 'manager', status: 200 },
    { actor: member, scope: 'owner-only', role: 'manager', status: 404 },
    { actor: admin, scope: 'owner-only', role: 'manager', status: 404 },
    { actor: 'outsider' as UserId, scope: 'project', role: 'contributor', status: 404 },
  ] as const) {
    await f.role(row.role); await f.updateSession({ shareScope: row.scope })
    if (row.status === 200) assert.equal((await f.service.admitFileWrite(sessionId, row.actor, input())).actorId, row.actor)
    else {
      for (const body of [input(), { ...input(), subpath: 'changed' }, null]) await assert.rejects(f.service.admitFileWrite(sessionId, row.actor, body), { status: row.status })
    }
  }
  assert.deepEqual(f.counts(), [['file-write-admission', 2], ['file-write-intent', 2]])
})

test('identical concurrent requests admit once with distinct actor-scoped identities; changed exact input or full binding conflicts', async t => {
  const f = await fixture(); t.after(() => f.close())
  let notifications = 0
  f.service.notifications.onCommands(f.session.binding.agent.workerId, () => { notifications++ })
  f.service.notifications.onSession(sessionId, () => { notifications++ })
  const results = await Promise.all(Array.from({ length: 20 }, () => f.service.admitFileWrite(sessionId, owner, input())))
  for (const result of results) assert.deepEqual(result, results[0])
  const first = results[0]
  assert.notEqual(first.admissionId, first.requestId)
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/)
  assert.equal(first.fingerprintVersion, 1)
  assert.deepEqual(first.binding, f.session.binding)
  assert.equal(first.workerId, f.session.binding.agent.workerId)
  assert.deepEqual(await f.store.fileWrites.getIntent(first.admissionId), { admissionId: first.admissionId, state: 'held' })
  assert.deepEqual(f.counts(), [['file-write-admission', 1], ['file-write-intent', 1]])
  const other = await f.service.admitFileWrite(sessionId, member, input())
  assert.notEqual(other.admissionId, first.admissionId)
  for (const body of [{ ...input(), subpath: 'changed' }, { ...input(), base64Content: 'Yg==' }]) await assert.rejects(f.service.admitFileWrite(sessionId, owner, body), { status: 409, code: 'request_id_conflict' })
  await f.updateSession({ binding: { ...f.session.binding, modelId: null } })
  await assert.rejects(f.service.admitFileWrite(sessionId, owner, input()), { status: 409 })
  await f.updateSession({ binding: f.session.binding })
  for (const binding of [
    { ...f.session.binding, workspaceId: 'other' as WorkspaceId },
    { ...f.session.binding, agent: { ...f.session.binding.agent, workerId: 'other' as WorkerId } },
    { ...f.session.binding, agent: { ...f.session.binding.agent, agentKey: 'other' as AgentKey } },
  ]) {
    // Worker/Workspace/Agent binding is already SQLite-immutable. Simulate a changed
    // authorized snapshot at the tx reader seam, without relaxing that invariant.
    const changed = intercepted(f.store, tx => ({ ...tx, resources: { ...tx.resources, getSession: async id => {
      const session = await tx.resources.getSession(id)
      return session ? { ...session, binding } : null
    } } }))
    await assert.rejects(makeService(changed).admitFileWrite(sessionId, owner, input()), { status: 409 })
  }
  await f.updateSession({ binding: f.session.binding })
  assert.deepEqual(await f.service.admitFileWrite(sessionId, owner, input()), first)
  assert.deepEqual(f.counts(), [['file-write-admission', 2], ['file-write-intent', 2]])
  assert.deepEqual(await f.store.commands.list({ limit: 100 }), [], 'held intent is not a command')
  assert.deepEqual(await f.store.commands.listDeliverable('worker' as WorkerId, 100), [], 'held intent cannot be dispatched')
  assert.equal(notifications, 0, 'admission has no operational wakeup')
})

test('replay rechecks ordered grant revocation, role, Task and Session/Project lifecycle', async t => {
  const f = await fixture(); t.after(() => f.close())
  await f.updateSession({ shareScope: 'selected-members' })
  await f.store.transaction(tx => tx.identity.saveSessionGrant({ sessionId, userId: member }))
  const first = await f.service.admitFileWrite(sessionId, member, input())
  const revoke = f.store.transaction(tx => tx.identity.removeSessionGrant(sessionId, member))
  await Promise.all([revoke, assert.rejects(f.service.admitFileWrite(sessionId, member, input()), { status: 404 }), assert.rejects(f.service.admitFileWrite(sessionId, member, { ...input(), subpath: 'conflict' }), { status: 404 })])
  await f.updateSession({ shareScope: 'project' }); await f.role('viewer')
  await assert.rejects(f.service.admitFileWrite(sessionId, member, input()), { status: 403 })
  await f.role('contributor')
  await f.store.transaction(async tx => { await tx.tasks.save({ ...(await tx.tasks.get(f.task.id))!, deletedAt: now() }) })
  await assert.rejects(f.service.admitFileWrite(sessionId, member, input()), { status: 410, code: 'task_deleted' })
  await f.updateSession({ shareScope: 'owner-only' })
  await assert.rejects(f.service.admitFileWrite(sessionId, member, input()), { status: 404 })
  await f.store.transaction(async tx => { await tx.resources.saveProject({ ...(await tx.resources.getProject(projectId))!, deletedAt: now() }) })
  await assert.rejects(f.service.admitFileWrite(sessionId, owner, input()), { status: 404, code: 'project_not_found' })
  await f.updateSession({ deletedAt: now() })
  await assert.rejects(f.service.admitFileWrite(sessionId, owner, input()), { status: 404, code: 'session_not_found' })
  assert.deepEqual(await f.store.fileWrites.get(first.admissionId), first, 'later revocation never rewrites the retained admission')
  assert.deepEqual(f.counts(), [['file-write-admission', 1], ['file-write-intent', 1]])
})

test('input is snapshotted before waiting for transaction; caller cannot supply Worker binding authority', async t => {
  const f = await fixture(); t.after(() => f.close())
  const entered = deferred(), release = deferred()
  const blocker = f.store.transaction(async () => { entered.resolve(); await release.promise })
  await entered.promise
  const mutable = { ...input(), binding: undefined as unknown }
  delete (mutable as Partial<typeof mutable>).binding
  const pending = f.service.admitFileWrite(sessionId, owner, mutable)
  mutable.requestId = 'changed'; mutable.subpath = 'changed'; mutable.base64Content = 'Yg=='
  mutable.binding = { workspaceId: 'attacker', agent: { workerId: 'attacker', agentKey: 'attacker' }, modelId: null }
  release.resolve(); await blocker
  const admission = await pending
  assert.deepEqual({ requestId: admission.requestId, subpath: admission.subpath, base64Content: admission.base64Content }, input())
  assert.deepEqual(admission.binding, f.session.binding)
  for (const extra of [{ workerId: 'attacker' }, { binding: f.session.binding }]) await assert.rejects(f.service.admitFileWrite(sessionId, owner, { ...input(), ...extra }), { status: 400 })
  const original = structuredClone(admission)
  ;(admission.binding.agent as { workerId: string }).workerId = 'mutated'
  assert.deepEqual(await f.store.fileWrites.get(admission.admissionId), original)
  const read = (await f.store.fileWrites.get(admission.admissionId))!
  ;(read.binding.agent as { workerId: string }).workerId = 'also-mutated'
  assert.deepEqual(await f.service.admitFileWrite(sessionId, owner, input()), original)
})

test('malformed request identity, path and base64 fail without persisting; empty file and size limit remain valid', async t => {
  const f = await fixture(); t.after(() => f.close())
  for (const body of [null, [], {}, { ...input(), requestId: '' }, { ...input(), requestId: 'x'.repeat(201) }, { ...input(), requestId: 'bad\0' },
    ...['', '/absolute', '../escape', 'a/../b', '.', 'a//b', 'a\\b', 'C:drive', 'bad\0', '\ud800', 'x'.repeat(4097)].map(subpath => ({ ...input(), subpath })),
    ...['YQ', 'YQ==\n', 'YR==', '!!!!', 'Y===', '😀', Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')].map(base64Content => ({ ...input(), base64Content })),
  ]) await assert.rejects(f.service.admitFileWrite(sessionId, owner, body), { status: 400 })
  assert.deepEqual(f.counts(), [])
  assert.equal((await f.service.admitFileWrite(sessionId, owner, { ...input(), base64Content: '' })).base64Content, '')
  const content = Buffer.alloc(10 * 1024 * 1024).toString('base64')
  assert.equal((await f.service.admitFileWrite(sessionId, owner, { ...input(), requestId: 'max', base64Content: content })).base64Content, content)
})

for (const rollback of [false, true]) test(`admission readers are committed-only and tx leases expire after ${rollback ? 'rollback' : 'commit'}`, async t => {
  const f = await fixture(); t.after(() => f.close())
  const entered = deferred(), release = deferred()
  let escaped!: ServerStoreTx, admitted!: FileWriteAdmission, captured!: ServerStoreTx['fileWrites']['insertHeld']
  const wrapped = intercepted(f.store, tx => ({ ...tx, fileWrites: { ...tx.fileWrites, insertHeld: async value => {
    escaped = tx; captured = tx.fileWrites.insertHeld; admitted = value
    await tx.fileWrites.insertHeld(value)
    assert.deepEqual(await tx.fileWrites.get(value.admissionId), value)
    assert.equal((await tx.fileWrites.getIntent(value.admissionId))?.state, 'held')
    await assert.rejects(f.store.fileWrites.get(value.admissionId), /Use tx readers/)
    await assert.rejects(f.store.transaction(async () => undefined), /Nested transactions/)
    entered.resolve(); await release.promise
    if (rollback) throw new Error('injected after admission and intent')
  } } }))
  const operation = makeService(wrapped).admitFileWrite(sessionId, owner, input())
  const completion = rollback ? assert.rejects(operation, /injected after admission and intent/) : operation
  await entered.promise
  assert.deepEqual(f.counts(), [], 'independent connection never sees uncommitted rows')
  let readCompleted = false
  const read = f.store.fileWrites.get(admitted.admissionId).then(value => { readCompleted = true; return value })
  await setImmediate(); assert.equal(readCompleted, false)
  release.resolve(); await completion
  assert.deepEqual(await read, rollback ? null : admitted)
  const rejectEscaped = async () => {
    await assert.rejects(escaped.fileWrites.get(admitted.admissionId), /Transaction is no longer active/)
    await assert.rejects(escaped.fileWrites.find(admitted), /Transaction is no longer active/)
    await assert.rejects(escaped.fileWrites.getIntent(admitted.admissionId), /Transaction is no longer active/)
    await assert.rejects(captured(admitted), /Transaction is no longer active/)
  }
  await rejectEscaped(); await f.store.transaction(async () => rejectEscaped())
  assert.deepEqual(f.counts(), rollback ? [] : [['file-write-admission', 1], ['file-write-intent', 1]])
})

test('intent insertion failure rolls back the admission SQL statement even if transaction caller catches it', async t => {
  const f = await fixture(); t.after(() => f.close())
  f.observer.exec("CREATE TRIGGER test_fail_intent BEFORE INSERT ON records WHEN NEW.kind='file-write-intent' BEGIN SELECT RAISE(ABORT,'injected intent failure'); END")
  await assert.rejects(f.service.admitFileWrite(sessionId, owner, input()), /injected intent failure/)
  assert.deepEqual(f.counts(), [])
  f.observer.exec('DROP TRIGGER test_fail_intent')
  const admission = await f.service.admitFileWrite(sessionId, owner, input())
  f.observer.exec("CREATE TRIGGER test_fail_intent BEFORE INSERT ON records WHEN NEW.kind='file-write-intent' BEGIN SELECT RAISE(ABORT,'injected intent failure'); END")
  await f.store.transaction(async tx => { await assert.rejects(tx.fileWrites.insertHeld({ ...admission, admissionId: 'other', requestId: 'other' }), /injected intent failure/) })
  assert.equal(await f.store.fileWrites.get('other'), null)
  assert.deepEqual(f.counts(), [['file-write-admission', 1], ['file-write-intent', 1]])
})

test('SQLite uniqueness and immutability protect records; reopen retains exact admission, key and held intent', async t => {
  const f = await fixture(); t.after(() => f.close())
  const first = await f.service.admitFileWrite(sessionId, owner, input())
  for (const value of [first, { ...first, admissionId: 'different' }]) await assert.rejects(f.store.transaction(tx => tx.fileWrites.insertHeld(value)), /immutable/)
  for (const kind of ['file-write-admission', 'file-write-intent']) {
    assert.throws(() => f.observer.prepare('UPDATE records SET data=data WHERE kind=? AND id=?').run(kind, first.admissionId), /immutable/)
    assert.throws(() => f.observer.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, first.admissionId), /immutable/)
  }
  assert.throws(() => f.observer.prepare('INSERT INTO records VALUES(?,?,?)').run('file-write-intent', 'orphan', JSON.stringify({ admissionId: 'orphan', state: 'held' })), /Invalid held/)
  const bytes = f.observer.prepare("SELECT data FROM records WHERE kind='file-write-admission' AND id=?").get(first.admissionId)!.data
  f.store.close()
  const reopened = new SqliteServerStore(f.path); t.after(() => reopened.close())
  assert.deepEqual(await reopened.fileWrites.get(first.admissionId), first)
  assert.deepEqual(await reopened.fileWrites.find(first), first)
  assert.deepEqual(await makeService(reopened).admitFileWrite(sessionId, owner, input()), first)
  assert.equal(f.observer.prepare("SELECT data FROM records WHERE kind='file-write-admission' AND id=?").get(first.admissionId)!.data, bytes)
  assert.deepEqual(await reopened.fileWrites.getIntent(first.admissionId), { admissionId: first.admissionId, state: 'held' })
  assert.equal(Number(f.observer.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n), migrationCount)
})

const replacementCases = [
  { name: 'fresh admissionId with existing request identity', kind: 'file-write-admission', change: (first: FileWriteAdmission) => ({ ...first, admissionId: 'replacement' }) },
  { name: 'same admissionId with changed shape-valid payload', kind: 'file-write-admission', change: (first: FileWriteAdmission) => ({ ...first, subpath: 'changed.txt', base64Content: 'Yg==' }) },
  { name: 'same admissionId with changed request identity', kind: 'file-write-admission', change: (first: FileWriteAdmission) => ({ ...first, requestId: 'replacement-request' }) },
  { name: 'existing held intent', kind: 'file-write-intent', change: (first: FileWriteAdmission) => ({ admissionId: first.admissionId, state: 'held' }) },
] as const

function admissionRows(db: DatabaseSync) {
  return db.prepare("SELECT kind,id,data FROM records WHERE kind IN ('file-write-admission','file-write-intent') ORDER BY kind,id").all()
}

for (const scenario of replacementCases) test(`SQLite replacement rejects ${scenario.name} with recursive triggers disabled`, async t => {
  const f = await fixture(); t.after(() => f.close())
  const first = await f.service.admitFileWrite(sessionId, owner, input())
  const originalRows = admissionRows(f.observer)
  f.observer.exec('PRAGMA recursive_triggers=OFF')
  assert.equal(f.observer.prepare('PRAGMA recursive_triggers').get()!.recursive_triggers, 0)
  const replacement = scenario.change(first)
  // Different JSON formatting also makes an otherwise identical intent replacement observable.
  assert.throws(() => {
    f.observer.prepare('INSERT OR REPLACE INTO records(kind,id,data) VALUES(?,?,?)')
      .run(scenario.kind, replacement.admissionId, JSON.stringify(replacement, null, 2))
    t.diagnostic(JSON.stringify({ unexpectedReplacementSucceeded: scenario.name, counts: f.counts(), originalAdmissionExists: Boolean(f.observer.prepare("SELECT 1 FROM records WHERE kind='file-write-admission' AND id=?").get(first.admissionId)), rawBytesChanged: JSON.stringify(admissionRows(f.observer)) !== JSON.stringify(originalRows) }))
  }, /immutable/)
  assert.deepEqual(admissionRows(f.observer), originalRows, 'original raw bytes and row identities unchanged')
  assert.deepEqual(f.counts(), [['file-write-admission', 1], ['file-write-intent', 1]])
  assert.deepEqual(await f.store.fileWrites.get(first.admissionId), first)
  assert.deepEqual(await f.store.fileWrites.find(first), first)
  assert.equal(await f.store.fileWrites.get('replacement'), null)
  assert.equal(await f.store.fileWrites.find({ ...first, requestId: 'replacement-request' }), null)
  assert.deepEqual(await f.store.fileWrites.getIntent(first.admissionId), { admissionId: first.admissionId, state: 'held' })
  f.store.close()
  const reopened = new SqliteServerStore(f.path)
  try {
    assert.deepEqual(admissionRows(f.observer), originalRows)
    assert.deepEqual(await reopened.fileWrites.get(first.admissionId), first)
    assert.deepEqual(await reopened.fileWrites.find(first), first)
    assert.deepEqual(await reopened.fileWrites.getIntent(first.admissionId), { admissionId: first.admissionId, state: 'held' })
    assert.deepEqual(await makeService(reopened).admitFileWrite(sessionId, owner, input()), first)
  } finally { reopened.close() }
})

test('stage 1 database upgrades append-only replacement guards without rewriting retained records', async t => {
  const f = await fixture(); t.after(() => f.close())
  const first = await f.service.admitFileWrite(sessionId, owner, input())
  const originalRows = admissionRows(f.observer)
  f.store.close()
  // Reconstruct the immediately preceding schema, preserving its recorded stage 1
  // migration, all original triggers/indexes, and existing admission/intent bytes.
  f.observer.exec('DROP TRIGGER file_write_admission_replace; DROP TRIGGER file_write_intent_replace')
  // This fixture specifically starts before replacement migration 33, even after
  // later append-only migrations are added.
  for (const row of f.observer.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'file_result_%'").all()) f.observer.exec(`DROP TRIGGER ${row.name}`)
  f.observer.exec('DROP TRIGGER IF EXISTS command_rejection_no_dispatch; DROP TABLE command_rejections')
  f.observer.exec('DROP INDEX IF EXISTS attention_failed_runs_order; DROP INDEX IF EXISTS attention_dead_letters_order; DROP INDEX IF EXISTS attention_human_reviews_order')
  f.observer.prepare('DELETE FROM schema_migrations WHERE version>=?').run(33)
  const previousVersions = f.observer.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
  assert.equal(previousVersions.length, 32)
  assert.equal(previousVersions.at(-1)!.version, 32)
  const originalSchema = f.observer.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'file_write_%' ORDER BY name").all()
  assert.equal(originalSchema.length, 6)
  f.observer.exec('PRAGMA recursive_triggers=OFF')
  let newAdmission: FileWriteAdmission | undefined
  for (let reopen = 0; reopen < 2; reopen++) {
    const upgraded = new SqliteServerStore(f.path)
    try {
      assert.deepEqual(f.observer.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version), Array.from({ length: migrationCount }, (_, index) => index + 1))
      assert.deepEqual(f.observer.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'file_write_%' AND name NOT IN ('file_write_admission_replace','file_write_intent_replace') ORDER BY name").all(), originalSchema)
      assert.equal(f.observer.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('file_write_admission_replace','file_write_intent_replace')").get()!.n, 2)
      const beforeAttempts = admissionRows(f.observer)
      for (const scenario of replacementCases) {
        const replacement = scenario.change(first)
        assert.throws(() => f.observer.prepare('INSERT OR REPLACE INTO records(kind,id,data) VALUES(?,?,?)')
          .run(scenario.kind, replacement.admissionId, JSON.stringify(replacement, null, 2)), /immutable/)
      }
      assert.deepEqual(admissionRows(f.observer), beforeAttempts)
      assert.deepEqual(admissionRows(f.observer).filter(row => row.id === first.admissionId), originalRows)
      assert.deepEqual(await upgraded.fileWrites.get(first.admissionId), first)
      assert.deepEqual(await upgraded.fileWrites.find(first), first)
      assert.deepEqual(await upgraded.fileWrites.getIntent(first.admissionId), { admissionId: first.admissionId, state: 'held' })
      const service = makeService(upgraded)
      assert.deepEqual(await service.admitFileWrite(sessionId, owner, input()), first)
      const admitted = await service.admitFileWrite(sessionId, owner, { ...input(), requestId: 'after-upgrade' })
      if (newAdmission) assert.deepEqual(admitted, newAdmission)
      else newAdmission = admitted
      assert.notEqual(admitted.admissionId, first.admissionId)
      assert.deepEqual(await service.admitFileWrite(sessionId, owner, { ...input(), requestId: 'after-upgrade' }), admitted)
      assert.deepEqual(await upgraded.fileWrites.getIntent(admitted.admissionId), { admissionId: admitted.admissionId, state: 'held' })
      assert.deepEqual(f.counts(), [['file-write-admission', 2], ['file-write-intent', 2]])
    } finally { upgraded.close() }
  }
})
