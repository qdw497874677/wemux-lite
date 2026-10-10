import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandId, SessionId, Timestamp, WorkerId } from '@wemux/domain'
import { SqliteWorkerStore } from '../src/storage/sqlite-store.js'
import { WorkerRuntime } from '../src/application/runtime.js'
import { SessionOwnership } from '../src/application/session-ownership.js'
import { TestAgent } from '../src/agents/test-agent.js'
import { LocalProvisioner } from '../src/workspaces/local-provisioner.js'

const id = 'coordination-session' as SessionId
const workerId = 'worker' as WorkerId
const wait = async (predicate: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  assert.fail('Timed out waiting for ownership handoff')
}

for (const failure of ['before-commit', 'after-commit', 'persistent'] as const) test(`terminal finalization ${failure} survives shutdown without relaunch`, async t => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-finalizer-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  t.after(() => store.close())
  const owner = new SessionOwnership()
  const token = owner.acquire(id)!
  const runtime = () => new WorkerRuntime(store, new LocalProvisioner(home), [new TestAgent()], { send() {} }, workerId, 'test', undefined, undefined, undefined, null, undefined, undefined, undefined, undefined, owner)
  const original = runtime()
  const replacement = runtime()
  const stamp = new Date().toISOString() as Timestamp
  let turnId: import('@wemux/domain').TurnId
  await store.transaction(async tx => {
    await tx.sessions.createSession(id, { workspaceId: 'workspace' as never, agent: { workerId, agentKey: 'test' as never }, modelId: 'test' as never })
    await tx.sessions.enqueue({ sessionId: id, submissionCommandId: 'queued' as CommandId, message: { messageId: 'message' as never, content: 'once' }, queuedAt: stamp })
    turnId = (await tx.sessions.claimNext(id))!.id
  })
  let attempts = 0
  let available = failure !== 'persistent'
  const originalError = console.error
  console.error = () => {}
  try {
    await original['finishClaimed'](id, token, async () => {
      attempts++
      if (!available || (failure !== 'persistent' && attempts === 1 && failure === 'before-commit')) throw new Error('before commit')
      await store.transaction(tx => tx.sessions.finishTurn({ turnId, outcome: 'completed', finishedAt: stamp }))
      if (attempts === 1 && failure === 'after-commit') throw new Error('after commit')
    })
    await original.shutdown()
    await replacement.initialize()
    assert.equal(owner.occupied(id), true, 'replacement must wait for the original finalizer')
    assert.equal((await store.sessions.get(id))?.activeTurnId, failure === 'after-commit' ? null : turnId)
    if (failure === 'persistent') {
      await new Promise(resolve => setTimeout(resolve, 350))
      assert.equal(owner.occupied(id), true)
      available = true
    }
    await wait(() => !owner.occupied(id))
    assert.equal((await store.sessions.get(id))?.activeTurnId, null)
    const events = (await store.journal.read({ sessionId: id, fromSeq: 1 as never, limit: 100 })).events
    assert.equal(events.filter(event => event.payload.kind === 'turn.started').length, 1)
    assert.equal(events.filter(event => event.payload.kind === 'turn.finished').length, 1)
  } finally { console.error = originalError; await replacement.shutdown() }
})

test('startup recovery reserves before asynchronous reads and cannot clear a live owner', async t => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-recovery-fence-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const store = new SqliteWorkerStore(join(home, 'worker.sqlite'))
  t.after(() => store.close())
  const owner = new SessionOwnership()
  const stamp = new Date().toISOString() as Timestamp
  await store.transaction(async tx => {
    await tx.sessions.createSession(id, { workspaceId: 'workspace' as never, agent: { workerId, agentKey: 'test' as never }, modelId: 'test' as never })
    await tx.sessions.enqueue({ sessionId: id, submissionCommandId: 'queued' as CommandId, message: { messageId: 'message' as never, content: 'once' }, queuedAt: stamp })
    await tx.sessions.claimNext(id)
  })
  const active = (await store.sessions.get(id))!.activeTurnId!
  let releaseRead!: () => void
  let reading!: () => void
  const started = new Promise<void>(resolve => { reading = resolve })
  const gate = new Promise<void>(resolve => { releaseRead = resolve })
  const delayed = new Proxy(store, { get(target, property) {
    if (property === 'transaction') return (work: Parameters<SqliteWorkerStore['transaction']>[0]) => target.transaction(async tx => {
      const sessions = new Proxy(tx.sessions, { get(reader, key) {
        if (key === 'getTurn') return async (turnId: typeof active) => { reading(); await gate; return reader.getTurn(turnId) }
        const value = Reflect.get(reader, key)
        return typeof value === 'function' ? value.bind(reader) : value
      } })
      return work({ ...tx, sessions })
    })
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const make = (state: SqliteWorkerStore) => new WorkerRuntime(state, new LocalProvisioner(home), [new TestAgent()], { send() {} }, workerId, 'test', undefined, undefined, undefined, null, undefined, undefined, undefined, undefined, owner)
  const first = make(delayed)
  const second = make(store)
  try {
    const initializing = first.initialize()
    await started
    assert.equal(owner.occupied(id), true, 'first recovery owns the slot during getTurn')
    const competing = second.initialize()
    assert.equal(owner.occupied(id), true, 'second recovery must not steal reserved slot')
    releaseRead()
    await initializing
    await competing
    await wait(async () => (await store.sessions.get(id))?.activeTurnId === null)
    assert.equal((await store.sessions.getTurn(active))?.state, 'failed')
    const events = (await store.journal.read({ sessionId: id, fromSeq: 1 as never, limit: 100 })).events
    assert.equal(events.filter(event => event.payload.kind === 'turn.finished').length, 1)
  } finally { releaseRead(); await first.shutdown(); await second.shutdown() }
})
