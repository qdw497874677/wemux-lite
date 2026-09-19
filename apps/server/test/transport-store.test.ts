import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandId, RequestId, RunId, Timestamp, WorkerId } from '@wemux/domain'
import { ServerTransportStore } from '../src/worker-ws/transport-store.js'

const workerId = randomUUID() as WorkerId
const command = () => ({
  type: 'command' as const, commandId: randomUUID() as CommandId, requestId: randomUUID() as RequestId,
  commandType: 'cancel_run' as const, issuedAt: new Date().toISOString() as Timestamp,
  body: { runId: randomUUID() as RunId },
})

test('an acknowledged command is re-enqueued for redelivery while its receipt is missing', () => {
  const store = new ServerTransportStore(':memory:')
  const payload = command()
  store.enqueue(workerId, payload)
  const frame = store.pending(workerId, 10)[0]!
  store.sent(workerId, frame)
  store.acknowledge(workerId, frame.deliveryEpoch, frame.directionSeq)
  assert.equal(store.pending(workerId, 10).length, 0)
  // 回归：传输确认只证明帧已送达，不等于应用层收据。应用层未收据的 Command 必须能按同一
  // commandId 重新入队重投，否则丢收据的 Command 会永远停在 pending。
  store.enqueue(workerId, payload)
  const replay = store.pending(workerId, 10)
  assert.equal(replay.length, 1)
  assert.equal(replay[0]!.directionSeq, frame.directionSeq + 1)
  assert.deepEqual(replay[0]!.payload, payload)
  // 未确认的帧仍然去重，避免同一次 flush 重复发送同一条 Command。
  store.enqueue(workerId, payload)
  assert.equal(store.pending(workerId, 10).length, 1)
  store.close()
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

test('frames enqueued after a full ack still get a fresh sequence and are delivered', () => {
  const store = new ServerTransportStore(':memory:')
  const first = command()
  store.enqueue(workerId, first)
  const firstFrame = store.pending(workerId, 10)[0]!
  store.sent(workerId, firstFrame)
  store.acknowledge(workerId, firstFrame.deliveryEpoch, firstFrame.directionSeq)
  assert.equal(store.pending(workerId, 10).length, 0)
  // 回归：已确认的行被删除后，新帧不能重用已被确认的序号，否则永远发不出去。
  store.enqueue(workerId, command())
  const second = store.pending(workerId, 10)
  assert.equal(second.length, 1)
  assert.equal(second[0]!.directionSeq, firstFrame.directionSeq + 1)
  assert.equal(second[0]!.deliveryEpoch, firstFrame.deliveryEpoch)
  store.acknowledge(workerId, second[0]!.deliveryEpoch, second[0]!.directionSeq)
  store.enqueue(workerId, command())
  const third = store.pending(workerId, 10)
  assert.deepEqual(third.map(frame => frame.directionSeq), [firstFrame.directionSeq + 2])
  store.close()
})

test('an ack beyond the enqueued high-water mark never strands later frames', () => {
  const store = new ServerTransportStore(':memory:')
  store.enqueue(workerId, command())
  const epoch = store.pending(workerId, 10)[0]!.deliveryEpoch
  // 越界确认（例如客户端说了自己没收到过的序号）必须被忽略，而不是把水位提到未来。
  store.acknowledge(workerId, epoch, 99)
  assert.equal(store.pending(workerId, 10).length, 1)
  store.enqueue(workerId, command())
  assert.deepEqual(store.pending(workerId, 10).map(frame => frame.directionSeq), [1, 2])
  store.close()
})

test('a legacy table without the high-water mark resumes above the acknowledged watermark', () => {
  const path = join(tmpdir(), `wemux-transport-legacy-${randomUUID()}.sqlite`)
  const store = new ServerTransportStore(path)
  store.enqueue(workerId, command())
  const firstFrame = store.pending(workerId, 10)[0]!
  store.sent(workerId, firstFrame)
  store.acknowledge(workerId, firstFrame.deliveryEpoch, firstFrame.directionSeq)
  store.close()
  // 模拟修复前的库：水位记录缺失，且已确认过的序号被重新使用而成为永远发不出去的残留行。
  const raw = new DatabaseSync(path)
  raw.prepare('DELETE FROM transport_meta WHERE worker_id=? AND key LIKE ?').run(workerId, `outbound_last_seq:${firstFrame.deliveryEpoch}%`)
  raw.prepare('INSERT INTO transport_outbox(worker_id,delivery_epoch,seq,message_id,dedupe_key,payload_json,created_at) VALUES(?,?,?,?,NULL,?,?)').run(workerId, firstFrame.deliveryEpoch, firstFrame.directionSeq, randomUUID(), JSON.stringify(command()), new Date().toISOString())
  raw.close()
  const upgraded = new ServerTransportStore(path)
  upgraded.enqueue(workerId, command())
  const pending = upgraded.pending(workerId, 10)
  assert.deepEqual(pending.map(frame => frame.directionSeq), [firstFrame.directionSeq + 1])
  upgraded.close()
})

test('a reconnect that declares a new worker delivery epoch is accepted instead of rejected', () => {
  const store = new ServerTransportStore(':memory:')
  const helloWithEpoch = (epoch: string) => ({
    frameType: 'transport.hello' as const, side: 'worker' as const, transport: { supportedMajors: [2], preferredMinorByMajor: { '2': 0 } },
    adkProfiles: ['wemux.adk.v1'], features: [], workerId, workerVersion: '1', name: 'w', platform: 'linux', architecture: 'x64',
    resume: { logicalConnectionId: null, workerToServer: { deliveryEpoch: epoch, ackThrough: 0 }, serverToWorker: null },
  })
  store.negotiate(workerId, helloWithEpoch('worker-epoch-1'))
  const payload = { type: 'heartbeat' as const, sentAt: new Date().toISOString() as Timestamp }
  const frame = { frameType: 'data' as const, durability: 'durable' as const, deliveryEpoch: 'worker-epoch-1', directionSeq: 1, messageId: randomUUID() as import('@wemux/domain').MessageId, lane: 'journal', payloadVersion: 'x', expiresAt: null, payload }
  assert.deepEqual(store.accept(workerId, frame), { isNew: true, ackThrough: 1 })
  // 回归：Worker 本地数据库重建后声明新世代，而服务端在旧世代仍有已确认帧。恢复被拒绝时不得把对端
  // 声明的 cursor 当权威，握手必须成功并只回服务端水位，长期 messageId 继续去重。
  const reconnect = store.negotiate(workerId, helloWithEpoch('worker-epoch-2'))
  assert.deepEqual(reconnect.authoritativeCursors.workerToServer, { deliveryEpoch: 'worker-epoch-2', ackThrough: 0 })
  assert.deepEqual(store.accept(workerId, { ...frame, deliveryEpoch: 'worker-epoch-2', messageId: randomUUID() as import('@wemux/domain').MessageId }), { isNew: true, ackThrough: 1 })
  store.close()
})

test('the first frame of an epoch without a proven prefix establishes the base', () => {
  const store = new ServerTransportStore(':memory:')
  const hello = store.negotiate(workerId, {
    frameType: 'transport.hello', side: 'worker', transport: { supportedMajors: [2], preferredMinorByMajor: { '2': 0 } },
    adkProfiles: ['wemux.adk.v1'], features: [], workerId, workerVersion: '1', name: 'w', platform: 'linux', architecture: 'x64',
    resume: { logicalConnectionId: null, workerToServer: { deliveryEpoch: 'worker-epoch', ackThrough: 0 }, serverToWorker: null },
  })
  const payload = { type: 'heartbeat' as const, sentAt: new Date().toISOString() as Timestamp }
  const frame = { frameType: 'data' as const, durability: 'durable' as const, deliveryEpoch: hello.authoritativeCursors.workerToServer.deliveryEpoch, directionSeq: 7, messageId: randomUUID() as import('@wemux/domain').MessageId, lane: 'journal', payloadVersion: 'x', expiresAt: null, payload }
  // 服务端数据库重建后水位为 0，Worker 仍从自身水位继续：首帧是唯一可证明的基准。
  assert.deepEqual(store.accept(workerId, frame), { isNew: true, ackThrough: 7 })
  assert.throws(() => store.accept(workerId, { ...frame, directionSeq: 9, messageId: randomUUID() as import('@wemux/domain').MessageId }), /transport gap/)
  assert.deepEqual(store.accept(workerId, { ...frame, directionSeq: 8, messageId: randomUUID() as import('@wemux/domain').MessageId }), { isNew: true, ackThrough: 8 })
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
