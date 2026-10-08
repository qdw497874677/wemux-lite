import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  FS_WRITE_ADMISSION_V1, FILE_WRITE_MAX_BYTES, fileWriteContentSize,
  serializeFileWriteFingerprint, serializeFileWriteResultDigest, serializeFileWriteRetainedResult,
  supportsFileWriteAdmission, parseFileWriteAdmitStructure, parseFileWriteResultStructure,
  parseServerTransportFrame, parseWorkerTransportFrame,
  type FileWriteAdmitPayload, type FileWriteResultPayload, type FileWriteResultAckPayload,
  type FileWriteOutcome, type FileWriteRetainedResult,
} from '../src/index.js'
import {
  computeFileWriteFingerprint, computeFileWriteResultDigest, parseFileWriteAdmit,
  parseFileWriteResult, parseFileWriteResultAck,
  parseVerifiedServerFileWriteFrame, parseVerifiedWorkerFileWriteFrame,
} from '../src/file-admission-node.js'
import { admitFileWriteInTx, snapshotFileWriteInput } from '../../../apps/server/src/application/file-write-admission.ts'

const fingerprint = '6dcceaa3ae2d054eaa01af990ed912bb3ef4357d12f2141704171fc1b91815df'
const resultDigest = '53530c7acdf9b7c02d1ed87af9ce09888a43c86a1dfb001e471da12a661d534c'
const tuple = '[1,"actor-1","session-1","client-1","fs.write","worker-1","workspace-1","worker-1","pi","provider/model","notes/你好.txt","aGVsbG8="]'
const admit = (): FileWriteAdmitPayload => ({
  type: 'fs.write.admit', requestId: 'admission-1', actorId: 'actor-1' as never,
  sessionId: 'session-1' as never, clientRequestId: 'client-1', operation: 'fs.write',
  workerId: 'worker-1' as never,
  binding: { workspaceId: 'workspace-1' as never, agent: { workerId: 'worker-1' as never, agentKey: 'pi' as never }, modelId: 'provider/model' as never },
  subpath: 'notes/你好.txt', base64Content: 'aGVsbG8=', fingerprintVersion: 1, fingerprint,
})
const result = (): FileWriteResultPayload => ({
  type: 'fs.write.result', requestId: 'admission-1', sessionId: 'session-1' as never, workerId: 'worker-1' as never,
  operation: 'fs.write', fingerprintVersion: 1, fingerprint, resultVersion: 1, outcome: 'succeeded',
  resultJson: '{"ok":true,"operation":"write","subpath":"notes/你好.txt","size":5}', resultDigest,
})
const ack = (): FileWriteResultAckPayload => {
  const { outcome, resultJson, ...identity } = result()
  return { ...identity, type: 'fs.write.result.ack' }
}
const durable = (payload: unknown) => ({ frameType: 'data', durability: 'durable', deliveryEpoch: 'epoch', directionSeq: 1, messageId: 'message-1', lane: 'command', payloadVersion: 'wemux.server.payload.v1', expiresAt: null, payload })
const volatile = (payload: unknown) => ({ frameType: 'data', durability: 'volatile', lane: 'realtime', payloadVersion: 'v1', payload })
const negotiation = { localFeatures: [FS_WRITE_ADMISSION_V1], peerFeatures: [FS_WRITE_ADMISSION_V1] }
const resign = (value: FileWriteResultPayload) => ({ ...value, resultDigest: computeFileWriteResultDigest(value) })

test('stable fingerprint vector matches real unchanged stage 1 admission function', async () => {
  const input = admit()
  assert.equal(serializeFileWriteFingerprint(input), tuple)
  assert.equal(computeFileWriteFingerprint(input), fingerprint)
  let inserted: unknown
  const tx = { fileWrites: { find: async () => null, insertHeld: async (value: unknown) => { inserted = value } } } as unknown as Parameters<typeof admitFileWriteInTx>[0]
  const session = { id: input.sessionId, binding: input.binding } as Parameters<typeof admitFileWriteInTx>[2]
  const record = await admitFileWriteInTx(tx, input.actorId, session, snapshotFileWriteInput({ requestId: input.clientRequestId, subpath: input.subpath, base64Content: input.base64Content }))
  assert.equal(record, inserted)
  assert.equal(record.fingerprintVersion, 1)
  assert.equal(record.fingerprint, fingerprint)
  assert.equal(record.requestId, input.clientRequestId)
  assert.notEqual(record.admissionId, record.requestId)
  assert.equal(parseFileWriteAdmit({ ...input, requestId: record.admissionId }).fingerprint, record.fingerprint)
  const nullModel = { ...input, binding: { ...input.binding, modelId: null } }
  assert.equal(computeFileWriteFingerprint(nullModel), createHash('sha256').update(tuple.replace('"provider/model"', 'null')).digest('hex'))
})

test('result digest vector binds exact retained bytes and identity with round trips', () => {
  assert.equal(computeFileWriteResultDigest(result()), resultDigest)
  assert.equal(createHash('sha256').update(serializeFileWriteResultDigest(result())).digest('hex'), resultDigest)
  assert.deepEqual(parseFileWriteAdmit(JSON.parse(JSON.stringify(admit()))), admit())
  assert.deepEqual(parseFileWriteResult(JSON.parse(JSON.stringify(result())), admit()), result())
  assert.deepEqual(parseFileWriteResultAck(JSON.parse(JSON.stringify(ack())), result()), ack())
})

for (const field of ['actorId', 'sessionId', 'clientRequestId', 'subpath', 'base64Content'] as const) {
  test(`admission fingerprint rejects tampered ${field}`, () => {
    assert.throws(() => parseFileWriteAdmit({ ...admit(), [field]: field === 'base64Content' ? 'd29ybGQ=' : 'changed' }))
  })
}
for (const field of ['workspaceId', 'modelId', 'agentKey', 'workerId'] as const) {
  test(`admission fingerprint rejects tampered binding ${field}`, () => {
    const input = admit()
    const binding = field === 'agentKey' || field === 'workerId'
      ? { ...input.binding, agent: { ...input.binding.agent, [field]: 'changed' } }
      : { ...input.binding, [field]: 'changed' }
    assert.throws(() => parseFileWriteAdmit({ ...input, binding }))
    if (field === 'workerId') assert.throws(() => parseFileWriteAdmit({ ...input, workerId: 'changed', binding }))
  })
}

test('admission rejects malformed exact keys, full binding, versions and digests', () => {
  for (const key of Object.keys(admit())) {
    const item: Record<string, unknown> = { ...admit() }; delete item[key]
    assert.throws(() => parseFileWriteAdmit(item), key)
  }
  for (const change of [
    { extra: 1 }, { type: 'fs.request' }, { requestId: '' }, { requestId: 'x'.repeat(201) },
    { actorId: '\0' }, { clientRequestId: '\n' }, { sessionId: [] }, { workerId: 'other' },
    { operation: 'write' }, { fingerprintVersion: 2 }, { fingerprint: '0'.repeat(64) },
    { fingerprint: fingerprint.toUpperCase() }, { fingerprint: 'bad' },
    { binding: {} }, { binding: { ...admit().binding, extra: true } },
    { binding: { ...admit().binding, modelId: undefined } },
    { binding: { ...admit().binding, agent: { ...admit().binding.agent, extra: true } } },
  ]) assert.throws(() => parseFileWriteAdmit({ ...admit(), ...change }), JSON.stringify(change))
  // Stage 1 intentionally excludes admissionId; changing it is a correlation check, not a fingerprint check.
  assert.doesNotThrow(() => parseFileWriteAdmit({ ...admit(), requestId: 'another-admission' }))
  assert.throws(() => parseFileWriteResult(result(), { ...admit(), requestId: 'another-admission' }))
})

test('path, identifiers and canonical base64 enforce byte bounds without normalization', () => {
  for (const subpath of ['', '/abs', '../a', 'a/../b', 'a//b', './a', 'a/', 'a\\b', 'C:a', 'a\0b', 'a\nb', '\ud800', 'é'.repeat(2049)]) {
    assert.throws(() => parseFileWriteAdmitStructure({ ...admit(), subpath }), JSON.stringify(subpath))
  }
  assert.doesNotThrow(() => parseFileWriteAdmitStructure({ ...admit(), subpath: 'é'.repeat(2048) }))
  assert.doesNotThrow(() => parseFileWriteAdmitStructure({ ...admit(), subpath: '\ufeffnotes.txt' }))
  for (const value of [null, [], 42, 'admit']) assert.throws(() => parseFileWriteAdmit(value))
  for (const value of ['', 'x'.repeat(201), '\ud800']) {
    for (const key of ['workspaceId', 'modelId']) assert.throws(() => parseFileWriteAdmitStructure({ ...admit(), binding: { ...admit().binding, [key]: value } }))
    for (const key of ['workerId', 'agentKey']) assert.throws(() => parseFileWriteAdmitStructure({ ...admit(), binding: { ...admit().binding, agent: { ...admit().binding.agent, [key]: value } } }))
  }
  for (const key of ['requestId', 'actorId', 'sessionId', 'clientRequestId', 'workerId']) {
    for (const value of ['', ' ', 'x'.repeat(201), '\ud800', 'x\x7f']) assert.throws(() => parseFileWriteAdmitStructure({ ...admit(), [key]: value }), key)
  }
  for (const value of ['Zg', 'Zg=', 'Zh==', 'Zm9=', '====', 'Zg==\n', 'Z g==', '____', 42, null]) assert.throws(() => fileWriteContentSize(value), String(value))
  for (const bytes of [Buffer.alloc(0), Buffer.from('f'), Buffer.from('fo'), Buffer.from('foo'), Buffer.alloc(FILE_WRITE_MAX_BYTES)]) assert.equal(fileWriteContentSize(bytes.toString('base64')), bytes.length)
  assert.throws(() => fileWriteContentSize(Buffer.alloc(FILE_WRITE_MAX_BYTES + 1).toString('base64')))
})

for (const field of ['requestId', 'sessionId', 'workerId', 'fingerprint', 'fingerprintVersion', 'operation', 'resultVersion', 'outcome', 'resultJson', 'resultDigest'] as const) {
  test(`result rejects tampered ${field}`, () => {
    const value = field === 'fingerprint' || field === 'resultDigest' ? '0'.repeat(64) : field === 'fingerprintVersion' || field === 'resultVersion' ? 2 : 'changed'
    assert.throws(() => parseFileWriteResult({ ...result(), [field]: value }, admit()))
    if (['requestId', 'sessionId', 'workerId', 'fingerprint'].includes(field)) {
      assert.throws(() => parseFileWriteResult(resign({ ...result(), [field]: value }), admit()), /identity mismatch/)
    }
  })
}

test('strict outcomes distinguish success, rejection before effect and uncertainty', () => {
  const cases: [FileWriteOutcome, FileWriteRetainedResult][] = [
    ['succeeded', { ok: true, operation: 'write', subpath: admit().subpath, size: 5 }],
    ['rejected-before-effect', { ok: false, operation: 'write', effect: 'not-started', error: 'Not authorized' }],
    ['unknown', { ok: false, operation: 'write', effect: 'uncertain', error: 'Interrupted after reservation' }],
  ]
  for (const [outcome, retained] of cases) {
    const payload = resign({ ...result(), outcome, resultJson: serializeFileWriteRetainedResult(outcome, retained) })
    assert.equal(parseFileWriteResult(payload, admit()).outcome, outcome)
    for (const [other] of cases) if (other !== outcome) assert.throws(() => parseFileWriteResult({ ...payload, outcome: other }, admit()))
  }
  for (const patch of [{ subpath: 'other' }, { size: 4 }]) {
    const payload = resign({ ...result(), resultJson: serializeFileWriteRetainedResult('succeeded', { ok: true, operation: 'write', subpath: admit().subpath, size: 5, ...patch }) })
    assert.throws(() => parseFileWriteResult(payload, admit()), /success result mismatch/)
  }
  for (const resultJson of [
    'null', '[]', '{', '{}', result().resultJson + ' ', result().resultJson.replace('"size":5', '"size":-1'),
    result().resultJson.replace('"size":5', '"size":1.5'), result().resultJson.replace('"size":5', '"size":5,"size":5'),
    result().resultJson.replace('"ok":true', '"ok":true,"extra":true'),
    '{"ok":false,"operation":"write","effect":"uncertain","error":""}',
  ]) assert.throws(() => parseFileWriteResultStructure({ ...result(), resultJson }), resultJson)
  for (const key of Object.keys(result())) {
    const item: Record<string, unknown> = { ...result() }; delete item[key]
    assert.throws(() => parseFileWriteResult(item, admit()), key)
  }
  assert.throws(() => parseFileWriteResult({ ...result(), extra: true }, admit()))
  for (const error of ['', ' ', '\0', '\ud800', 'é'.repeat(2049)]) assert.throws(() => serializeFileWriteRetainedResult('unknown', { ok: false, operation: 'write', effect: 'uncertain', error }))
  for (const size of [FILE_WRITE_MAX_BYTES + 1, NaN, Infinity]) assert.throws(() => serializeFileWriteRetainedResult('succeeded', { ok: true, operation: 'write', subpath: 'a', size }))
})

test('ACK requires the exact retained identity, fingerprint, version and digest', () => {
  for (const [key, value] of Object.entries(ack())) {
    const item: Record<string, unknown> = { ...ack() }; delete item[key]
    assert.throws(() => parseFileWriteResultAck(item, result()), key)
    assert.throws(() => parseFileWriteResultAck({ ...ack(), [key]: typeof value === 'number' ? 2 : key === 'fingerprint' || key === 'resultDigest' ? '0'.repeat(64) : 'changed' }, result()), key)
  }
  assert.throws(() => parseFileWriteResultAck({ ...ack(), extra: true }, result()))
  assert.throws(() => parseFileWriteResultAck(ack(), { ...result(), resultDigest: '0'.repeat(64) }))
})

test('direction and durability checks cover all new messages, and verified entrypoints check raw frames', () => {
  for (const payload of [admit(), ack()]) {
    assert.doesNotThrow(() => parseServerTransportFrame(durable(payload)))
    assert.throws(() => parseWorkerTransportFrame(durable(payload)))
    assert.throws(() => parseServerTransportFrame(volatile(payload)))
    assert.throws(() => parseVerifiedServerFileWriteFrame(volatile(payload), negotiation, result()))
    assert.deepEqual(parseVerifiedServerFileWriteFrame(durable(payload), negotiation, result()).payload, payload)
  }
  assert.doesNotThrow(() => parseWorkerTransportFrame(durable(result())))
  assert.throws(() => parseServerTransportFrame(durable(result())))
  assert.throws(() => parseWorkerTransportFrame(volatile(result())))
  assert.deepEqual(parseVerifiedWorkerFileWriteFrame(durable(result()), negotiation, admit()).payload, result())
  assert.throws(() => parseVerifiedWorkerFileWriteFrame(volatile(result()), negotiation, admit()))
  assert.throws(() => parseVerifiedWorkerFileWriteFrame(durable(admit()), negotiation, admit()))
  assert.throws(() => parseVerifiedServerFileWriteFrame(durable(result()), negotiation))
  assert.throws(() => parseVerifiedServerFileWriteFrame(durable(ack()), negotiation))
  for (const change of [{ extra: true }, { directionSeq: 0 }, { lane: 'realtime' }, { expiresAt: 'bad' }]) {
    assert.throws(() => parseVerifiedServerFileWriteFrame({ ...durable(admit()), ...change }, negotiation))
    assert.throws(() => parseVerifiedWorkerFileWriteFrame({ ...durable(result()), ...change }, negotiation, admit()))
  }
  const tampered = { ...admit(), fingerprint: '0'.repeat(64) }
  assert.doesNotThrow(() => parseServerTransportFrame(durable(tampered))) // Explicit structural-only API.
  assert.throws(() => parseVerifiedServerFileWriteFrame(durable(tampered), negotiation))
  assert.throws(() => parseVerifiedWorkerFileWriteFrame(durable({ ...result(), resultDigest: '0'.repeat(64) }), negotiation, admit()))
})

test('negotiation requires both explicit advertisements and does not alter legacy frames', () => {
  for (const [localFeatures, peerFeatures] of [[undefined, undefined], [[], []], [[FS_WRITE_ADMISSION_V1], undefined], [undefined, [FS_WRITE_ADMISSION_V1]], [[FS_WRITE_ADMISSION_V1], []], [[], [FS_WRITE_ADMISSION_V1]], [['durable-ack', '2'], ['bounded-replay', '2']]] as const) {
    assert.equal(supportsFileWriteAdmission(localFeatures, peerFeatures), false)
    const absent = { localFeatures, peerFeatures }
    assert.throws(() => parseVerifiedServerFileWriteFrame(durable(admit()), absent))
    assert.throws(() => parseVerifiedWorkerFileWriteFrame(durable(result()), absent, admit()))
  }
  assert.equal(supportsFileWriteAdmission(negotiation.localFeatures, negotiation.peerFeatures), true)
  for (const frame of [durable({ type: 'fs.request', operation: 'write' }), volatile({ type: 'fs.request', operation: 'write' })]) assert.deepEqual(parseServerTransportFrame(frame), frame)
  for (const frame of [durable({ type: 'fs.response', ok: false }), volatile({ type: 'fs.response', ok: false })]) assert.deepEqual(parseWorkerTransportFrame(frame), frame)
  const base = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  for (const name of ['apps/server/src/worker-ws/transport-store.ts', 'apps/worker/src/transport/transport-store.ts']) assert.equal(readFileSync(resolve(base, name), 'utf8').includes(FS_WRITE_ADMISSION_V1), false)
})
