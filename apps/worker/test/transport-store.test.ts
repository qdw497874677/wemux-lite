import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CommandId, MessageId, RequestId, RunId, Timestamp, WorkerId } from '@wemux/domain'
import { WorkerTransportStore } from '../src/transport/transport-store.js'

const tempPath = (name: string) => join(mkdtempSync(join(tmpdir(), `${name}-`)), 'transport.sqlite')

const workerId = randomUUID() as WorkerId

test('persists outbound payloads until acknowledged', async () => {
  const store = new WorkerTransportStore(':memory:')
  await store.enqueue({ type: 'heartbeat', sentAt: new Date().toISOString() as Timestamp })
  const [frame] = await store.pendingOutbound(10)
  assert.ok(frame)
  assert.equal((await store.pendingOutbound(10)).length, 1)
  await store.markOutboundSent(frame)
  assert.equal((await store.pendingOutbound(10)).length, 0)
  await store.acknowledgeOutbound({ frameType: 'transport.ack', deliveryEpoch: frame.deliveryEpoch, ackThrough: frame.directionSeq })
  assert.equal((await store.pendingOutbound(10)).length, 0)
  store.close()
})

test('sent but unacknowledged payload becomes replayable after a new handshake', async () => {
  const store = new WorkerTransportStore(':memory:')
  await store.enqueue({ type: 'heartbeat', sentAt: new Date().toISOString() as Timestamp })
  const [frame] = await store.pendingOutbound(10)
  assert.ok(frame)
  await store.markOutboundSent(frame)
  assert.equal((await store.pendingOutbound(10)).length, 0)

  await store.acceptServerHello({
    frameType: 'transport.hello', side: 'server', selectedTransport: { major: 2, minor: 0 }, selectedAdkProfile: 'wemux.adk.v1', enabledFeatures: [], logicalConnectionId: randomUUID(), connectionEpoch: randomUUID(), resumeAccepted: true,
    authoritativeCursors: { workerToServer: { deliveryEpoch: frame.deliveryEpoch, ackThrough: 0 }, serverToWorker: { deliveryEpoch: 'server-epoch', ackThrough: 0 } }, acceptedAt: new Date().toISOString() as Timestamp,
  })

  assert.deepEqual((await store.pendingOutbound(10)).map((item) => item.directionSeq), [1])
  store.close()
})

test('acknowledged outbound payload stays cleared after restart', async () => {
  const path = tempPath('transport-store-restart')
  let store = new WorkerTransportStore(path)
  await store.enqueue({ type: 'heartbeat', sentAt: new Date().toISOString() as Timestamp })
  const [frame] = await store.pendingOutbound(10)
  assert.ok(frame)
  await store.acknowledgeOutbound({ frameType: 'transport.ack', deliveryEpoch: frame.deliveryEpoch, ackThrough: frame.directionSeq })
  store.close()
  store = new WorkerTransportStore(path)
  assert.equal((await store.pendingOutbound(10)).length, 0)
  store.close()
})

test('dropOldestUnacked advances the durable cursor so replay continues without a gap', async () => {
  const store = new WorkerTransportStore(':memory:')
  for (const sentAt of ['a', 'b', 'c']) await store.enqueue({ type: 'heartbeat', sentAt } as never)
  const frames = await store.pendingOutbound(10)
  assert.equal(frames.length, 3)
  await store.acknowledgeOutbound({ frameType: 'transport.ack', deliveryEpoch: frames[0]!.deliveryEpoch, ackThrough: 1 })
  const dropped = await store.dropOldestUnacked()
  assert.equal(dropped?.seq, 2)
  assert.equal((dropped?.payload as { sentAt?: string }).sentAt, 'b')
  await store.acceptServerHello({
    frameType: 'transport.hello', side: 'server', selectedTransport: { major: 2, minor: 0 }, selectedAdkProfile: 'wemux.adk.v1', enabledFeatures: [], logicalConnectionId: randomUUID(), connectionEpoch: randomUUID(), resumeAccepted: true,
    authoritativeCursors: { workerToServer: { deliveryEpoch: frames[0]!.deliveryEpoch, ackThrough: 2 }, serverToWorker: { deliveryEpoch: 'server-epoch', ackThrough: 0 } }, acceptedAt: new Date().toISOString() as Timestamp,
  })
  assert.deepEqual((await store.pendingOutbound(10)).map(frame => frame.directionSeq), [3])
  store.close()
})

test('acceptServerHello adopts a rebuilt server delivery epoch without failing the connection', async () => {
  const store = new WorkerTransportStore(':memory:')
  const outboundEpoch = store.workerHello({ workerId, workerVersion: '1', name: 'w', platform: 'linux', architecture: 'x64', adkProfiles: ['wemux.adk.v1'] }).resume.workerToServer.deliveryEpoch
  const helloWithEpoch = (epoch: string) => ({
    frameType: 'transport.hello' as const, side: 'server' as const, selectedTransport: { major: 2 as const, minor: 0 }, selectedAdkProfile: 'wemux.adk.v1', enabledFeatures: [], logicalConnectionId: randomUUID(), connectionEpoch: randomUUID(), resumeAccepted: true,
    authoritativeCursors: { workerToServer: { deliveryEpoch: outboundEpoch, ackThrough: 0 }, serverToWorker: { deliveryEpoch: epoch, ackThrough: 0 } }, acceptedAt: new Date().toISOString() as Timestamp,
  })
  await store.acceptServerHello(helloWithEpoch('server-epoch-1'))
  const payload = { type: 'command' as const, commandId: randomUUID() as CommandId, requestId: randomUUID() as RequestId, commandType: 'cancel_run' as const, issuedAt: new Date().toISOString() as Timestamp, body: { runId: randomUUID() as RunId } }
  const frame = { frameType: 'data' as const, durability: 'durable' as const, deliveryEpoch: 'server-epoch-1', directionSeq: 1, messageId: randomUUID() as MessageId, lane: 'command', payloadVersion: 'x', expiresAt: null, payload }
  assert.equal((await store.acceptInbound(frame)).isNew, true)
  // 回归：Server 自身数据库重建后开启新世代，而本端仍有旧世代的 ACK 水位。恢复被拒绝时不得把对端
  // 声明的 cursor 当权威，必须采纳 Server 的权威水位而不是把连接判成不可恢复。
  await store.acceptServerHello(helloWithEpoch('server-epoch-2'))
  assert.equal((await store.acceptInbound({ ...frame, deliveryEpoch: 'server-epoch-2', messageId: randomUUID() as MessageId })).isNew, true)
  store.close()
})

test('commits inbound before ack and suppresses duplicate delivery', async () => {
  const store = new WorkerTransportStore(':memory:')
  const outboundEpoch = (await store.pendingOutbound(1))[0]?.deliveryEpoch ?? store.workerHello({ workerId, workerVersion: '1', name: 'w', platform: 'linux', architecture: 'x64', adkProfiles: ['wemux.adk.v1'] }).resume.workerToServer.deliveryEpoch
  await store.acceptServerHello({
    frameType: 'transport.hello', side: 'server', selectedTransport: { major: 2, minor: 0 }, selectedAdkProfile: 'wemux.adk.v1', enabledFeatures: [], logicalConnectionId: randomUUID(), connectionEpoch: randomUUID(), resumeAccepted: true,
    authoritativeCursors: { workerToServer: { deliveryEpoch: outboundEpoch, ackThrough: 0 }, serverToWorker: { deliveryEpoch: 'server-epoch', ackThrough: 0 } }, acceptedAt: new Date().toISOString() as Timestamp,
  })
  const payload = { type: 'command' as const, commandId: randomUUID() as CommandId, requestId: randomUUID() as RequestId, commandType: 'cancel_run' as const, issuedAt: new Date().toISOString() as Timestamp, body: { runId: randomUUID() as RunId } }
  const frame = { frameType: 'data' as const, durability: 'durable' as const, deliveryEpoch: 'server-epoch', directionSeq: 1, messageId: randomUUID() as MessageId, lane: 'command', payloadVersion: 'x', expiresAt: null, payload }
  assert.equal((await store.acceptInbound(frame)).isNew, true)
  assert.equal((await store.acceptInbound(frame)).isNew, false)
  await assert.rejects(store.acceptInbound({ ...frame, directionSeq: 3, messageId: randomUUID() as MessageId }), /transport gap/)
  store.close()
})
