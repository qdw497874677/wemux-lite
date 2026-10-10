import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ServerTransportStore } from '../worker-ws/transport-store.ts'
import type { WorkerId } from '@wemux/domain'
import type { WorkerHelloFrame } from '@wemux/wire-protocol'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const workerId = 'worker-with-receipt' as WorkerId
const command = (id: string) => ({ type: 'command' as const, commandId: id, command: { kind: 'session.cancel' as const, sessionId: 'session' as never } })

test('a re-observed worker epoch keeps the committed cursor after switching away', () => {
  const store = new ServerTransportStore(':memory:')
  const hello = (epoch: string): WorkerHelloFrame => ({
    frameType: 'transport.hello', side: 'worker', workerId, name: 'test', workerVersion: '1', platform: 'linux', architecture: 'x64',
    transport: { supportedMajors: [2], preferredMinorByMajor: { '2': 0 } }, adkProfiles: ['wemux.adk.v1'], features: [],
    resume: { logicalConnectionId: null, workerToServer: { deliveryEpoch: epoch, ackThrough: 0 }, serverToWorker: null },
  })
  const frame = (epoch: string, seq: number, messageId: string) => ({
    frameType: 'data' as const, durability: 'durable' as const, deliveryEpoch: epoch, directionSeq: seq,
    messageId: messageId as never, lane: 'control' as const, payloadVersion: 'wemux.worker.payload.v1', expiresAt: null,
    payload: { type: 'heartbeat' as const, sentAt: new Date().toISOString() as never },
  })
  try {
    store.negotiate(workerId, hello('epoch-1'))
    const first = randomUUID()
    assert.equal(store.accept(workerId, frame('epoch-1', 1, first)).isNew, true)
    store.negotiate(workerId, hello('epoch-2'))
    assert.equal(store.accept(workerId, frame('epoch-2', 1, randomUUID())).isNew, true)
    const again = store.negotiate(workerId, hello('epoch-1'))
    assert.equal(again.authoritativeCursors.workerToServer.ackThrough, 1)
    assert.equal(store.accept(workerId, frame('epoch-1', 1, first)).isNew, false)
  } finally { store.close() }
})

test('retained unsigned enqueue blocks transport replay without skipping its sequence', () => {
  const store = new ServerTransportStore(':memory:')
  try {
    store.enqueue(workerId, { type: 'command', commandId: 'old' as never, command: { kind: 'session.enqueue', sessionId: 'session' as never, message: { messageId: 'old' as never, content: 'old' } } })
    store.enqueue(workerId, { type: 'heartbeat', sentAt: new Date().toISOString() as never })
    assert.deepEqual(store.pending(workerId, 64), [])
    assert.deepEqual(store.pending(workerId, 64), [], 'restarting the reader cannot bypass the barrier')
  } finally { store.close() }
})

test('a serialized legacy unsigned approval blocks replay and cannot leapfrog across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wemux-legacy-approval-'))
  const path = join(dir, 'transport.sqlite')
  try {
    const store = new ServerTransportStore(path)
    store.enqueue(workerId, command('before') as never)
    store.enqueue(workerId, { type: 'command', commandId: 'old-approval' as never, command: { kind: 'runtime.approval.resolve', sessionId: 'session' as never, turnId: 'turn' as never, approvalId: 'approval' as never, decision: 'approve' } })
    store.enqueue(workerId, command('after') as never)
    const first = store.pending(workerId, 64)
    assert.deepEqual(first.map(frame => frame.directionSeq), [1])
    const epoch = first[0]!.deliveryEpoch
    store.acknowledge(workerId, epoch, 1)
    assert.deepEqual(store.pending(workerId, 64), [])
    store.close()
    const reopened = new ServerTransportStore(path)
    try {
      assert.deepEqual(reopened.pending(workerId, 64), [])
      const db = new DatabaseSync(path)
      try {
        const rows = db.prepare('SELECT seq,payload_json,last_sent_at FROM transport_outbox ORDER BY seq').all() as Array<{ seq: number; payload_json: string; last_sent_at: string | null }>
        assert.deepEqual(rows.map(row => row.seq), [2, 3], 'the blocked row remains for explicit development cleanup')
        assert.equal(JSON.parse(rows[0]!.payload_json).command.kind, 'runtime.approval.resolve')
        assert.equal(rows[0]!.last_sent_at, null, 'legacy approval was never emitted')
      } finally { db.close() }
    } finally { reopened.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an application receipt cannot open a hole in the unacknowledged transport stream', () => {
  const store = new ServerTransportStore(':memory:')
  try {
    store.enqueue(workerId, command('first') as never)
    store.enqueue(workerId, command('second') as never)
    const before = store.pending(workerId, 64)
    assert.deepEqual(before.map(frame => frame.directionSeq), [1, 2])
    store.discardCommand(workerId, 'first')
    // The receipt confirms the command's effect, NOT arrival of the separate
    // transport ACK. If the latter was lost, replay must retain sequence 1.
    assert.deepEqual(store.pending(workerId, 64).map(frame => frame.directionSeq), [1, 2])
    assert.equal(store.pending(workerId, 1)[0]?.messageId, before[0]?.messageId)
    store.acknowledge(workerId, before[0]!.deliveryEpoch, 1)
    assert.deepEqual(store.pending(workerId, 64).map(frame => frame.directionSeq), [2])
    store.acknowledge(workerId, before[0]!.deliveryEpoch, 2)
    assert.deepEqual(store.pending(workerId, 64), [])
  } finally { store.close() }
})
