import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { historyManifestDigest, SessionHistoryGate } from '../src/application/session-history-gate.ts'
import type { HistoryScope, PrepareManifest, ReleaseManifest, RootAdmission } from '../src/application/session-history-gate.ts'
import { writeWorkspaceFile } from '../src/files/workspace-files.ts'
import { SessionHistoryGateStore } from '../src/storage/session-history-gate-store.ts'

const scope: HistoryScope = { authority: 'trusted-test-manifest', workerId: 'worker', storeId: 'private-store', sessionId: 'session', binding: 'placement', recoveryEpoch: 'epoch' }
const fingerprint = (subpath: string, base64Content: string) => createHash('sha256').update(JSON.stringify([subpath, base64Content])).digest('hex')
const root = (subpath: string, bytes: Buffer): RootAdmission => ({ scope, id: 'held-R', generation: 1, sequence: 1, kind: 'fs.write', coverage: 'root-only', fingerprint: fingerprint(subpath, bytes.toString('base64')) })
const manifests = (admissions: RootAdmission[]) => {
  const prepare: PrepareManifest = { scope, barrierId: 'barrier', generation: 1, revision: 1, cutoff: 1, admissions, digest: '' }
  prepare.digest = historyManifestDigest(prepare)
  const release: ReleaseManifest = { ...prepare, prepareRevision: 1, revision: 2, newGeneration: 2 }
  release.digest = historyManifestDigest(release)
  return { prepare, release }
}
const pause = () => {
  let resume!: () => void
  const promise = new Promise<void>(resolve => { resume = resolve })
  return { promise, resume }
}

// Only a write callback exists. No Runtime, delete, stop, cancel, dispose or process handles.
const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-history-fs-'))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'original.bin'), Buffer.from('original'))
  const path = join(dir, 'private.sqlite')
  let store = new SessionHistoryGateStore(path)
  let gate = new SessionHistoryGate(store, scope)
  let calls = 0
  return {
    workspace, get gate() { return gate }, get calls() { return calls },
    reopen() { store.close(); store = new SessionHistoryGateStore(path); gate = new SessionHistoryGate(store, scope) },
    async deliver(identity: RootAdmission, subpath: string, bytes: Buffer, options: { beforeWrite?: () => Promise<void>; afterWrite?: () => Promise<void>; crashAfterWrite?: boolean } = {}) {
      // Snapshot caller-owned bytes before reservation; fingerprint and effect share this immutable payload.
      const base64Content = bytes.toString('base64')
      const actual = { ...identity, fingerprint: fingerprint(subpath, base64Content) }
      const decision = gate.reserveEffect(actual)
      if (decision.status !== 'execute') return decision
      // A second connection can take the write lock, proving reservation committed before I/O.
      const observer = new DatabaseSync(path)
      try {
        observer.exec('BEGIN IMMEDIATE')
        const persisted = JSON.parse(String(observer.prepare('SELECT body FROM history_gate WHERE id=1').get()?.body))
        assert.equal(persisted.admissions.find((item: { identity: RootAdmission }) => item.identity.id === identity.id).state, 'reserved')
        observer.exec('COMMIT')
      } finally { observer.close() }
      await options.beforeWrite?.()
      calls++
      const result = await writeWorkspaceFile(workspace, subpath, base64Content)
      await options.afterWrite?.()
      if (options.crashAfterWrite) throw new Error('simulated crash after awaited write/close before settlement')
      const resultBytes = Buffer.from(JSON.stringify(result))
      assert.equal(gate.settleEffect(actual, resultBytes).status, 'accepted')
      return { status: 'written' as const, result: resultBytes }
    },
    async close() { store.close(); await rm(dir, { recursive: true, force: true }) },
  }
}

test('private fs effect: release-before-prepare carries held write exactly once and replays original bytes', async () => {
  const f = await fixture()
  try {
    const bytes = Buffer.from([0, 1, 128, 255])
    const identity = root('original.bin', bytes)
    const control = manifests([identity])
    assert.equal(f.gate.release(control.release).status, 'accepted')
    const before = f.gate.inspect()
    assert.equal(f.gate.prepare(control.prepare).status, 'unchanged')
    assert.deepEqual(f.gate.inspect(), before)
    const first = await f.deliver(identity, 'original.bin', bytes)
    assert.equal(first.status, 'written')
    assert.equal(f.calls, 1)
    assert.deepEqual(await readFile(join(f.workspace, 'original.bin')), bytes)
    const metadata = await stat(join(f.workspace, 'original.bin'))
    f.reopen()
    const replay = await f.deliver(identity, 'original.bin', bytes)
    assert.equal(replay.status, 'replay')
    if (first.status !== 'written' || replay.status !== 'replay') assert.fail('expected original durable result')
    assert.deepEqual(replay.result, first.result)
    assert.equal(f.calls, 1)
    assert.deepEqual(await readFile(join(f.workspace, 'original.bin')), bytes)
    assert.equal((await stat(join(f.workspace, 'original.bin'))).mtimeMs, metadata.mtimeMs)
  } finally { await f.close() }
})

test('private fs effect: caller buffer mutation during beforeWrite cannot change admitted bytes', async () => {
  const f = await fixture()
  const reserved = pause(), start = pause()
  let running: ReturnType<typeof f.deliver> | undefined
  try {
    const original = Buffer.from([0, 1, 128, 255])
    const callerBytes = Buffer.from(original)
    const identity = root('original.bin', original)
    assert.equal(f.gate.recordAdmission(identity).status, 'accepted')
    running = f.deliver(identity, 'original.bin', callerBytes, {
      beforeWrite: async () => { reserved.resume(); await start.promise },
    })
    await reserved.promise
    assert.equal(f.calls, 0)
    assert.equal(f.gate.inspect().admissions[0].state, 'reserved')
    callerBytes.fill(42)
    assert.notDeepEqual(callerBytes, original)
    start.resume()
    const first = await running
    assert.equal(first.status, 'written')
    assert.deepEqual(await readFile(join(f.workspace, 'original.bin')), original)
    assert.equal(f.calls, 1)
    const settled = f.gate.inspect()
    assert.equal((await f.deliver(identity, 'original.bin', callerBytes)).status, 'reject')
    assert.deepEqual(f.gate.inspect(), settled)
    assert.equal(f.calls, 1)
    assert.deepEqual(await readFile(join(f.workspace, 'original.bin')), original)
    const replay = await f.deliver(identity, 'original.bin', original)
    if (first.status !== 'written' || replay.status !== 'replay') assert.fail('expected original durable result')
    assert.deepEqual(replay.result, first.result)
    assert.deepEqual(f.gate.inspect(), settled)
    assert.equal(f.calls, 1)
    assert.deepEqual(await readFile(join(f.workspace, 'original.bin')), original)
  } finally { start.resume(); await running; await f.close() }
})

test('private fs effect: unknown identity, path/content conflict and wrong scope reject before I/O without erasing history', async () => {
  const f = await fixture()
  try {
    const bytes = Buffer.from('new bytes')
    const identity = root('original.bin', bytes)
    assert.equal(f.gate.release(manifests([identity]).release).status, 'accepted')
    const before = f.gate.inspect()
    const requests: [RootAdmission, string, Buffer][] = [
      [{ ...identity, id: 'unnamed', sequence: 2 }, 'original.bin', bytes],
      [identity, 'other.bin', bytes], [identity, 'original.bin', Buffer.from('changed content')],
      [{ ...identity, generation: 2 }, 'original.bin', bytes],
      [{ ...identity, sequence: 2 }, 'original.bin', bytes],
    ]
    for (const key of Object.keys(scope) as (keyof HistoryScope)[]) requests.push([{ ...identity, scope: { ...scope, [key]: 'wrong' } }, 'original.bin', bytes])
    for (const request of requests) {
      assert.equal((await f.deliver(...request)).status, 'reject')
      assert.equal(f.calls, 0)
      assert.deepEqual(f.gate.inspect(), before)
      assert.equal(await readFile(join(f.workspace, 'original.bin'), 'utf8'), 'original')
    }
    await assert.rejects(stat(join(f.workspace, 'other.bin')), { code: 'ENOENT' })
    assert.equal(f.gate.inspect().admissions.length, 1)
  } finally { await f.close() }
})

test('private fs effect: duplicate during reservation and running write awaits existing execution across release', async () => {
  const f = await fixture()
  const reserved = pause(), start = pause(), written = pause(), settle = pause()
  let running: ReturnType<typeof f.deliver> | undefined
  try {
    const bytes = Buffer.from('running write')
    const identity = root('original.bin', bytes)
    assert.equal(f.gate.recordAdmission(identity).status, 'accepted')
    running = f.deliver(identity, 'original.bin', bytes, {
      beforeWrite: async () => { reserved.resume(); await start.promise },
      afterWrite: async () => { written.resume(); await settle.promise },
    })
    await reserved.promise
    assert.equal(f.gate.prepare(manifests([identity]).prepare).status, 'accepted')
    assert.equal(f.gate.inspect().localSubsetSettled, false)
    assert.equal(f.gate.release(manifests([identity]).release).status, 'accepted')
    assert.equal((await f.deliver(identity, 'original.bin', bytes)).status, 'awaitExisting')
    assert.equal(f.calls, 0)
    start.resume()
    await written.promise
    assert.deepEqual(await readFile(join(f.workspace, 'original.bin')), bytes)
    assert.equal((await f.deliver(identity, 'original.bin', bytes)).status, 'awaitExisting')
    assert.equal(f.gate.release(manifests([identity]).release).status, 'unchanged')
    assert.equal(f.calls, 1)
    settle.resume()
    assert.equal((await running).status, 'written')
    assert.equal((await f.deliver(identity, 'original.bin', bytes)).status, 'replay')
    assert.equal(f.calls, 1)
  } finally { start.resume(); settle.resume(); await running; await f.close() }
})

test('private fs effect: explicitly unknown potentially executed root stays ineligible across release and reopen', async () => {
  const f = await fixture()
  try {
    const bytes = Buffer.from('effect outcome not recorded')
    const identity = root('original.bin', bytes)
    assert.equal(f.gate.recordAdmission(identity).status, 'accepted')
    await assert.rejects(f.deliver(identity, 'original.bin', bytes, { crashAfterWrite: true }), /simulated crash/)
    assert.equal(f.gate.markUnknown(identity).status, 'accepted')
    assert.equal(f.gate.release(manifests([identity]).release).status, 'accepted')
    f.reopen()
    assert.equal((await f.deliver(identity, 'original.bin', bytes)).status, 'unknown')
    assert.equal(f.gate.inspect().localSubsetSettled, false)
    assert.equal(f.calls, 1)
    assert.deepEqual(await readFile(join(f.workspace, 'original.bin')), bytes)
  } finally { await f.close() }
})

test('private fs effect: crash after bytes before settlement reopens unknown, never reruns or settles on timeout', async () => {
  const f = await fixture()
  try {
    const bytes = Buffer.from('bytes survived crash')
    const identity = root('original.bin', bytes)
    assert.equal(f.gate.recordAdmission(identity).status, 'accepted')
    assert.equal(f.gate.prepare(manifests([identity]).prepare).status, 'accepted')
    await assert.rejects(f.deliver(identity, 'original.bin', bytes, { crashAfterWrite: true }), /simulated crash/)
    assert.equal(f.calls, 1)
    assert.deepEqual(await readFile(join(f.workspace, 'original.bin')), bytes)
    assert.equal(f.gate.inspect().admissions[0].state, 'reserved')
    f.reopen()
    assert.equal(f.gate.inspect().admissions[0].state, 'unknown')
    assert.equal(f.gate.inspect().localSubsetSettled, false)
    // Mere time and a would-be late result neither settle nor release the prepared gate.
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(f.gate.settleEffect(identity, Buffer.from('timeout')).status, 'reject')
    assert.equal(f.gate.inspect().mode, 'prepared')
    assert.equal((await f.deliver(identity, 'original.bin', bytes)).status, 'unknown')
    assert.equal(f.gate.release(manifests([identity]).release).status, 'accepted')
    assert.equal(f.gate.inspect().admissions[0].state, 'unknown')
    f.reopen()
    assert.equal((await f.deliver(identity, 'original.bin', bytes)).status, 'unknown')
    assert.equal(f.calls, 1)
    assert.deepEqual(await readFile(join(f.workspace, 'original.bin')), bytes)
  } finally { await f.close() }
})
