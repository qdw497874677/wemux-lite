import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { CommandId, RequestId, RunId, Timestamp, WorkerId } from '@wemux/domain'
import { ServerTransportStore } from '../src/worker-ws/transport-store.js'

const workerId = randomUUID() as WorkerId
const command = () => ({
  type: 'command' as const, commandId: randomUUID() as CommandId, requestId: randomUUID() as RequestId,
  commandType: 'cancel_run' as const, issuedAt: new Date().toISOString() as Timestamp,
  body: { runId: randomUUID() as RunId },
})

test('outbox replays until cumulative ack and deduplicates a command', () => {
  const store = new ServerTransportStore(':memory:')
  const payload = command()
  store.enqueue(workerId, payload)
  store.enqueue(workerId, payload)
  const pending = store.pending(workerId, 10)
  assert.equal(pending.length, 1)
  assert.equal(store.pending(workerId, 10).length, 1)
  const frame = pending[0]!
  assert.equal(frame.durability, 'durable')
  store.acknowledge(workerId, frame.deliveryEpoch, frame.directionSeq)
  assert.equal(store.pending(workerId, 10).length, 0)
  store.close()
})

test('inbox returns the same ack for a duplicate and rejects a sequence gap', () => {
  const store = new ServerTransportStore(':memory:')
  const hello = store.negotiate(workerId, {
    frameType: 'transport.hello', side: 'worker', transport: { supportedMajors: [2], preferredMinorByMajor: { '2': 0 } },
    adkProfiles: ['wemux.adk.v1'], features: [], workerId, workerVersion: '1', name: 'w', platform: 'linux', architecture: 'x64',
    resume: { logicalConnectionId: null, workerToServer: { deliveryEpoch: 'worker-epoch', ackThrough: 0 }, serverToWorker: null },
  })
  const payload = { type: 'heartbeat' as const, sentAt: new Date().toISOString() as Timestamp }
  const frame = { frameType: 'data' as const, durability: 'durable' as const, deliveryEpoch: hello.authoritativeCursors.workerToServer.deliveryEpoch, directionSeq: 1, messageId: randomUUID() as import('@wemux/domain').MessageId, lane: 'journal', payloadVersion: 'x', expiresAt: null, payload }
  assert.deepEqual(store.accept(workerId, frame), { isNew: true, ackThrough: 1 })
  assert.deepEqual(store.accept(workerId, frame), { isNew: false, ackThrough: 1 })
  assert.throws(() => store.accept(workerId, { ...frame, directionSeq: 3, messageId: randomUUID() as import('@wemux/domain').MessageId }), /transport gap/)
  store.close()
})
