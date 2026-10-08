import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { WEMUX_ADK_PROFILE_V1 as DOMAIN_ADK_PROFILE } from '@wemux/domain'
import { WEMUX_ADK_PROFILE_V1, parseServerTransportFrame, parseWorkerTransportFrame } from '../src/index.js'

const workerHello = () => ({
  frameType: 'transport.hello', side: 'worker',
  transport: { supportedMajors: [2], preferredMinorByMajor: { '2': 0 } },
  adkProfiles: [WEMUX_ADK_PROFILE_V1], features: ['durable-ack'],
  workerId: randomUUID(), workerVersion: '1.0.0', name: 'worker', platform: 'linux', architecture: 'x64',
  resume: { logicalConnectionId: null, workerToServer: { deliveryEpoch: randomUUID(), ackThrough: 0 }, serverToWorker: null },
})

test('transport negotiates the domain-owned ADK profile instead of defining another conversation contract', () => {
  assert.equal(WEMUX_ADK_PROFILE_V1, DOMAIN_ADK_PROFILE)
})

test('parses a strict worker transport hello', () => {
  assert.equal(parseWorkerTransportFrame(workerHello()).frameType, 'transport.hello')
})

test('rejects v1 application envelopes', () => {
  assert.throws(() => parseWorkerTransportFrame({ type: 'heartbeat', sentAt: new Date().toISOString() }))
  assert.throws(() => parseServerTransportFrame({ type: 'command', commandId: randomUUID() }))
})

test('rejects unknown fields and the wrong payload direction', () => {
  assert.throws(() => parseWorkerTransportFrame({ ...workerHello(), extra: true }))
  assert.throws(() => parseWorkerTransportFrame({
    frameType: 'data', durability: 'durable', deliveryEpoch: randomUUID(), directionSeq: 1,
    messageId: randomUUID(), lane: 'command', payloadVersion: 'x', expiresAt: null,
    payload: { type: 'command', commandId: randomUUID(), requestId: randomUUID(), commandType: 'cancel_run', issuedAt: new Date().toISOString(), body: { runId: randomUUID() } },
  }))
})

test('approval transport replay preserves explicit Turn and the original command body', () => {
  const command = { kind: 'runtime.approval.resolve', sessionId: 'session', turnId: 'original-turn', approvalId: 'approval', decision: 'approve' }
  const payload = { type: 'command', commandId: 'immutable-command', command }
  const frame = { frameType: 'data', durability: 'durable', deliveryEpoch: 'epoch', directionSeq: 1, messageId: 'message', lane: 'command', payloadVersion: '1', expiresAt: null, payload }
  const first = parseServerTransportFrame(JSON.parse(JSON.stringify(frame)))
  const replay = parseServerTransportFrame(JSON.parse(JSON.stringify({ ...frame, directionSeq: 2 })))
  assert.equal(first.frameType, 'data'); assert.equal(replay.frameType, 'data')
  if (first.frameType === 'data' && replay.frameType === 'data') {
    assert.deepEqual(first.payload, payload)
    assert.deepEqual(replay.payload, first.payload)
  }
})
