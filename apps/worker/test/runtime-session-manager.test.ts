import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ModelId, SessionId } from '@wemux/domain'
import type { AgentRuntimeSession, RuntimeSessionAdapter } from '../src/application/ports/runtime-session.js'
import { RuntimeSessionManager } from '../src/application/runtime-session-manager.js'

const id = (value: string) => value as SessionId
const open = (sessionId: SessionId) => ({ sessionId, cwd: '/tmp/work', modelId: 'test' as ModelId, resume: null })

function fixture() {
  const opened: string[] = []
  const closed: string[] = []
  let releaseClose: (() => void) | undefined
  const adapters = new Map<string, AgentRuntimeSession>()
  const adapter: RuntimeSessionAdapter = {
    openSession: async input => {
      opened.push(input.sessionId)
      const session: AgentRuntimeSession = {
        execute: async () => { throw new Error('not used') },
        close: async () => { closed.push(input.sessionId); if (releaseClose) await new Promise<void>(resolve => releaseClose = resolve) },
      }
      adapters.set(input.sessionId, session)
      return session
    },
  }
  return { adapter, opened, closed, holdClose: () => { releaseClose = () => undefined }, releaseClose: () => { const resolve = releaseClose; releaseClose = undefined; resolve?.() } }
}

const wait = () => new Promise(resolve => setImmediate(resolve))

test('same fingerprint reuses one idle runtime session; changed fingerprint closes before replacement', async () => {
  const f = fixture()
  const manager = new RuntimeSessionManager(f.adapter, { idleTtlMs: 60_000 })
  const first = await manager.acquire(open(id('s1')), 'a')
  const generation = first.generation
  await first.release()
  const reused = await manager.acquire(open(id('s1')), 'a')
  assert.equal(reused.generation, generation)
  assert.equal(f.opened.length, 1)
  await reused.release()
  const changed = await manager.acquire(open(id('s1')), 'b')
  assert.notEqual(changed.generation, generation)
  assert.deepEqual(f.closed, ['s1'])
  assert.equal(f.opened.length, 2)
  await changed.release()
  await manager.shutdown()
})

test('active runtime cannot be leased twice and is never evicted by idle limit', async () => {
  const f = fixture()
  const manager = new RuntimeSessionManager(f.adapter, { idleTtlMs: 60_000, maxIdle: 1 })
  const active = await manager.acquire(open(id('active')), 'a')
  await assert.rejects(manager.acquire(open(id('active')), 'a'), /active operation/)
  const idle1 = await manager.acquire(open(id('idle-1')), 'a'); await idle1.release()
  const idle2 = await manager.acquire(open(id('idle-2')), 'a'); await idle2.release()
  assert.equal(f.closed.includes('active'), false)
  assert.equal(manager.snapshot().filter(entry => entry.leases === 0).length, 1)
  await active.release()
  await manager.shutdown()
})

test('fault removes a generation; a late release is idempotent and cannot close its replacement', async () => {
  const f = fixture()
  const manager = new RuntimeSessionManager(f.adapter, { idleTtlMs: 60_000 })
  const failed = await manager.acquire(open(id('s1')), 'a')
  await failed.fault()
  const replacement = await manager.acquire(open(id('s1')), 'a')
  await failed.release()
  assert.equal(manager.snapshot()[0]?.generation, replacement.generation)
  assert.equal(f.closed.length, 1)
  await replacement.release()
  await manager.shutdown()
})

test('commands and approvals route through the active managed session', async () => {
  const calls: string[] = []
  const adapter: RuntimeSessionAdapter = { async openSession() { return {
    async execute() { throw new Error('unused') },
    async command(command) { calls.push(`command:${command.name}`) },
    async resolveApproval(approvalId, decision) { calls.push(`approval:${approvalId}:${decision}`) },
    async close() {},
  } } }
  const manager = new RuntimeSessionManager(adapter)
  const lease = await manager.acquire(open(id('s-command')), 'fp')
  await manager.command(id('s-command'), { operationId: 'op-1' as never, name: 'compact', arguments: {} })
  await manager.resolveApproval(id('s-command'), 'approval-1' as never, 'approve', () => {})
  assert.deepEqual(calls, ['command:compact', 'approval:approval-1:approve'])
  await lease.release()
  await manager.shutdown()
})

test('idle TTL closes only after release and shutdown closes remaining sessions', async () => {
  const f = fixture()
  const manager = new RuntimeSessionManager(f.adapter, { idleTtlMs: 5 })
  const lease = await manager.acquire(open(id('s1')), 'a')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(f.closed, [])
  await lease.release()
  await new Promise(resolve => setTimeout(resolve, 15)); await wait()
  assert.deepEqual(f.closed, ['s1'])
  const next = await manager.acquire(open(id('s2')), 'a')
  await next.release()
  await manager.shutdown()
  assert.deepEqual(f.closed, ['s1', 's2'])
  await assert.rejects(manager.acquire(open(id('s3')), 'a'), /closed/)
})
