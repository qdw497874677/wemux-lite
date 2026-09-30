import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ServerTransportStore } from '../worker-ws/transport-store.ts'
import type { WorkerId } from '@wemux/domain'
import type { WorkerHelloFrame } from '@wemux/wire-protocol'
import { randomUUID } from 'node:crypto'

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
