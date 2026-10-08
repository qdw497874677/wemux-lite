import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { historyManifestDigest, SessionHistoryGate } from '../src/application/session-history-gate.ts'
import type { HistoryScope, PrepareManifest, ReleaseManifest, RootAdmission } from '../src/application/session-history-gate.ts'
import { SessionHistoryGateStore } from '../src/storage/session-history-gate-store.ts'

const scope: HistoryScope = { authority: 'test-authority', workerId: 'worker', storeId: 'private-store', sessionId: 'session', binding: 'workspace-placement', recoveryEpoch: 'test-epoch' }
const admission = (patch: Partial<RootAdmission> = {}): RootAdmission => ({
  scope, id: 'root-R', generation: 1, sequence: 1, kind: 'fs.write', coverage: 'root-only',
  fingerprint: createHash('sha256').update('path+bytes').digest('hex'), ...patch,
})
const prepare = (admissions: RootAdmission[], patch: Partial<PrepareManifest> = {}): PrepareManifest => {
  const manifest = { scope, barrierId: 'barrier-1', generation: 1, revision: 1, cutoff: 1, admissions, digest: '', ...patch }
  return { ...manifest, digest: historyManifestDigest(manifest) }
}
const release = (admissions: RootAdmission[], patch: Partial<ReleaseManifest> = {}): ReleaseManifest => {
  const manifest = { ...prepare(admissions), prepareRevision: 1, revision: 2, newGeneration: 2, ...patch }
  return { ...manifest, digest: historyManifestDigest(manifest) }
}
const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-history-gate-'))
  const path = join(dir, 'private.sqlite')
  let store = new SessionHistoryGateStore(path)
  let gate = new SessionHistoryGate(store, scope)
  return {
    path, get gate() { return gate },
    reopen() { store.close(); store = new SessionHistoryGateStore(path); gate = new SessionHistoryGate(store, scope) },
    async close() { store.close(); await rm(dir, { recursive: true, force: true }) },
  }
}

test('private gate: release first imports held root, old prepare is inert, and controls survive reopen', async () => {
  const f = await fixture()
  try {
    const root = admission()
    const manifest = release([root])
    assert.equal(f.gate.release(manifest).status, 'accepted')
    const released = f.gate.inspect()
    assert.equal(released.generation, 2)
    assert.equal(released.admissions[0].state, 'admitted')
    assert.equal(f.gate.prepare(prepare([root])).status, 'unchanged')
    assert.deepEqual(f.gate.inspect(), released)
    f.reopen()
    assert.equal(f.gate.release(manifest).status, 'unchanged')
    assert.deepEqual(f.gate.inspect(), released)
    assert.equal(f.gate.release(release([root], { cutoff: 2 })).status, 'reject')
    assert.equal(f.gate.prepare(prepare([root], { cutoff: 2 })).status, 'reject')
    assert.deepEqual(f.gate.inspect(), released)
  } finally { await f.close() }
})

test('private gate: every scope component and manifest digest is checked before import', async () => {
  const f = await fixture()
  try {
    const before = f.gate.inspect()
    for (const key of Object.keys(scope) as (keyof HistoryScope)[]) {
      const wrongScope = { ...scope, [key]: 'wrong' }
      assert.equal(f.gate.release(release([admission({ scope: wrongScope })], { scope: wrongScope })).status, 'reject')
      assert.equal(f.gate.release(release([admission({ scope: wrongScope })])).status, 'reject')
      assert.equal(f.gate.recordAdmission(admission({ scope: wrongScope })).status, 'reject')
      assert.deepEqual(f.gate.inspect(), before)
    }
    assert.equal(f.gate.release({ ...release([admission()]), digest: 'bad' }).status, 'reject')
    assert.deepEqual(f.gate.inspect(), before)
    const invalidScopeStore = new SessionHistoryGateStore(':memory:')
    try { assert.throws(() => new SessionHistoryGate(invalidScopeStore, { ...scope, authority: '' }), /Invalid private history scope/) }
    finally { invalidScopeStore.close() }
  } finally { await f.close() }
})

test('private gate: exact running duplicate attaches, release cannot settle it, and unknown survives reopen', async () => {
  const f = await fixture()
  try {
    const root = admission()
    assert.equal(f.gate.recordAdmission(root).status, 'accepted')
    assert.equal(f.gate.reserveEffect(root).status, 'execute')
    assert.equal(f.gate.release(release([root])).status, 'accepted')
    assert.equal(f.gate.reserveEffect(root).status, 'awaitExisting')
    assert.equal(f.gate.recordAdmission(root).status, 'unchanged')
    assert.equal(f.gate.markUnknown(root).status, 'accepted')
    assert.equal(f.gate.markUnknown(root).status, 'unchanged')
    assert.equal(f.gate.reserveEffect(root).status, 'unknown')
    assert.equal(f.gate.settleEffect(root, Buffer.from('timeout')).status, 'reject')
    f.reopen()
    assert.equal(f.gate.reserveEffect(root).status, 'unknown')
    assert.equal(f.gate.inspect().localSubsetSettled, false)
    assert.equal(f.gate.inspect().admissions.length, 1)
  } finally { await f.close() }
})

test('private gate: next fence must account for carried obligations even with no new admissions', async () => {
  const f = await fixture()
  try {
    const root = admission()
    assert.equal(f.gate.release(release([root])).status, 'accepted')
    const next = { barrierId: 'barrier-2', generation: 2, revision: 3, cutoff: 0 }
    const before = f.gate.inspect()
    assert.equal(f.gate.prepare(prepare([], next)).status, 'reject')
    assert.deepEqual(f.gate.inspect(), before)
    assert.equal(f.gate.prepare(prepare([root], next)).status, 'accepted')
    assert.equal(f.gate.inspect().localSubsetSettled, false)
    assert.equal(f.gate.recordAdmission(admission({ id: 'new', generation: 2 })).status, 'reject')
    assert.equal(f.gate.reserveEffect(root).status, 'execute')
    assert.equal(f.gate.inspect().localSubsetSettled, false)
    const bytes = Buffer.from([0, 255, 128, 10])
    assert.equal(f.gate.settleEffect(root, bytes).status, 'accepted')
    assert.equal(f.gate.inspect().localSubsetSettled, true)
    assert.equal(f.gate.settleEffect(root, bytes).status, 'unchanged')
    assert.equal(f.gate.settleEffect(root, Buffer.from('different')).status, 'reject')
    assert.equal(f.gate.markUnknown(root).status, 'reject')
    f.reopen()
    assert.deepEqual(f.gate.reserveEffect(root), { status: 'replay', result: bytes })
    // Previously terminal controls cannot undo the newer fence.
    const fenced = f.gate.inspect()
    assert.equal(f.gate.release(release([root])).status, 'unchanged')
    assert.equal(f.gate.prepare(prepare([root])).status, 'unchanged')
    assert.deepEqual(f.gate.inspect(), fenced)
  } finally { await f.close() }
})

test('private gate: failed release rolls back carried imports and revision together; lost reply is recoverable', async () => {
  const f = await fixture()
  const db = new DatabaseSync(f.path)
  try {
    const root = admission()
    const before = f.gate.inspect()
    db.exec(`CREATE TRIGGER fail_release AFTER UPDATE ON history_gate
      WHEN json_extract(NEW.body, '$.revision') = 2
      BEGIN SELECT RAISE(ABORT, 'injected release failure'); END;`)
    assert.throws(() => f.gate.release(release([root])), /injected release failure/)
    assert.deepEqual(f.gate.inspect(), before)
    f.reopen()
    assert.deepEqual(f.gate.inspect(), before)
    db.exec('DROP TRIGGER fail_release')
    assert.equal(f.gate.release(release([root])).status, 'accepted')
    f.reopen()
    const after = f.gate.inspect()
    assert.equal(f.gate.release(release([root])).status, 'unchanged')
    assert.equal(f.gate.release(release([admission({ fingerprint: 'f'.repeat(64) })])).status, 'reject')
    assert.deepEqual(f.gate.inspect(), after)
    assert.equal(after.revision, 2)
    assert.equal(after.admissions.length, 1)
  } finally { db.close(); await f.close() }
})

test('private gate: omissions, conflicting controls, unsupported coverage and invalid generations fail closed', async () => {
  const f = await fixture()
  try {
    const root = admission()
    assert.equal(f.gate.recordAdmission(root).status, 'accepted')
    const before = f.gate.inspect()
    const invalidReleases = [
      release([]), release([root], { newGeneration: 3 }), release([root], { prepareRevision: 2 }),
      release([root], { generation: 2, newGeneration: 3 }), release([root], { cutoff: 0 }),
      release([root, root]), release([root, admission({ id: 'other' })]),
    ]
    for (const manifest of invalidReleases) {
      assert.equal(f.gate.release(manifest).status, 'reject')
      assert.deepEqual(f.gate.inspect(), before)
    }
    for (const patch of [{ coverage: 'approval' }, { coverage: 'child' }, { coverage: 'delegation' }, { kind: 'shell' }, { generation: 0 }, { sequence: -1 }, { sequence: 1.1 }]) {
      const unsupported = admission({ ...patch, id: 'unsupported' })
      assert.equal(f.gate.recordAdmission(unsupported).status, 'reject')
      assert.equal(f.gate.reserveEffect(unsupported).status, 'reject')
      assert.equal(f.gate.prepare(prepare([root, unsupported])).status, 'reject')
      assert.equal(f.gate.release(release([root, unsupported])).status, 'reject')
      assert.deepEqual(f.gate.inspect(), before)
    }
    assert.equal(f.gate.prepare(release([root])).status, 'reject')
    assert.equal(f.gate.prepare(prepare([root])).status, 'accepted')
    const prepared = f.gate.inspect()
    assert.equal(f.gate.prepare(prepare([root])).status, 'unchanged')
    assert.equal(f.gate.release(release([root], { barrierId: 'other' })).status, 'reject')
    assert.equal(f.gate.release(release([root], { cutoff: 2 })).status, 'reject')
    assert.equal(f.gate.prepare(prepare([root], { barrierId: 'other', revision: 2 })).status, 'reject')
    assert.deepEqual(f.gate.inspect(), prepared)
    assert.equal(f.gate.release(release([root])).status, 'accepted')
    assert.equal(f.gate.recordAdmission(admission({ id: 'unnamed', sequence: 2 })).status, 'reject')
    assert.equal(f.gate.recordAdmission(admission({ id: 'future', generation: 3 })).status, 'reject')
    const released = f.gate.inspect()
    assert.equal(f.gate.prepare(prepare([root], { barrierId: 'stale' })).status, 'reject')
    assert.equal(f.gate.release(release([root], { barrierId: 'stale' })).status, 'reject')
    assert.deepEqual(f.gate.inspect(), released)
  } finally { await f.close() }
})

test('private gate: pending old effect excludes a new-generation effect until actual settlement', async () => {
  const f = await fixture()
  try {
    const old = admission()
    const next = admission({ id: 'new', generation: 2 })
    assert.equal(f.gate.recordAdmission(old).status, 'accepted')
    assert.equal(f.gate.reserveEffect(old).status, 'execute')
    assert.equal(f.gate.release(release([old])).status, 'accepted')
    assert.equal(f.gate.recordAdmission(next).status, 'accepted')
    assert.equal(f.gate.reserveEffect(next).status, 'reject')
    assert.equal(f.gate.settleEffect(old, Buffer.from('actual result')).status, 'accepted')
    assert.equal(f.gate.reserveEffect(next).status, 'execute')
    f.reopen()
    assert.equal(f.gate.reserveEffect(next).status, 'unknown')
    assert.equal(f.gate.settleEffect(next, Buffer.from('late old-owner result')).status, 'reject')
  } finally { await f.close() }
})

test('private store rejects unrelated databases without changing their schema or application data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-history-unrelated-'))
  const path = join(dir, 'unrelated.sqlite')
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TABLE documents (body TEXT); INSERT INTO documents VALUES ('untouched'); PRAGMA user_version=5;")
    assert.throws(() => new SessionHistoryGateStore(path), /Not a supported private history gate database/)
    assert.equal(db.prepare('SELECT body FROM documents').get()?.body, 'untouched')
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 5)
    assert.equal(db.prepare('PRAGMA application_id').get()?.application_id, 0)
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()?.n, 1)
  } finally { db.close(); await rm(dir, { recursive: true, force: true }) }
})
