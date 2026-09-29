import test from 'node:test'
import assert from 'node:assert/strict'
import { parseServerTransportFrame, parseWorkerTransportFrame } from '../src/index.js'

const hash = 'a'.repeat(64)
const now = '2026-04-01T00:00:00.000Z'
const durable = (payload: unknown) => ({ frameType: 'data', durability: 'durable', deliveryEpoch: 'epoch-1', directionSeq: 1, messageId: 'message-1', lane: 'snapshot', payloadVersion: 'resource.v1', expiresAt: null, payload })

test('parses resource set notify without blobs', () => {
  const frame = parseServerTransportFrame(durable({ type: 'resource.set.notify', workerId: 'worker-1', setRevision: 2, fingerprint: hash, resources: [{ bindingId: 'binding-1', resourceRevisionId: 'revision-1', kind: 'skill', contentSha256: hash }] }))
  assert.equal(frame.frameType, 'data')
  if (frame.frameType !== 'data') return
  assert.equal(frame.payload.type, 'resource.set.notify')
  assert.equal('base64Content' in frame.payload, false)
})

test('parses worker pulls and complete snapshots with file hashes', () => {
  assert.doesNotThrow(() => parseWorkerTransportFrame(durable({ type: 'resource.set.pull', action: 'request', requestId: 'pull-1', workerId: 'worker-1', knownSetRevision: 1 })))
  assert.doesNotThrow(() => parseServerTransportFrame(durable({ type: 'resource.set.pull', action: 'snapshot', requestId: 'pull-1', resourceSet: { workerId: 'worker-1', revision: 2, fingerprint: hash, createdAt: now, bindings: [{ bindingId: 'binding-1', bindingRevision: 1, agentKey: null, projectId: null, resourceRevisionId: 'revision-1', resourceId: 'resource-1', kind: 'skill', contentSha256: hash, files: [{ path: 'SKILL.md', size: 3, mediaType: 'text/markdown', sha256: hash, blobSha256: hash }] }] } })))
})

test('resource snapshot scope must explicitly carry project and Agent filters', () => {
  const binding = { bindingId: 'binding-1', bindingRevision: 1, agentKey: 'pi', projectId: 'project-1', resourceRevisionId: 'revision-1', resourceId: 'resource-1', kind: 'skill', contentSha256: hash, files: [] }
  const payload = (item: unknown) => durable({ type: 'resource.set.pull', action: 'snapshot', requestId: 'pull-1', resourceSet: { workerId: 'worker-1', revision: 2, fingerprint: hash, createdAt: now, bindings: [item] } })
  assert.doesNotThrow(() => parseServerTransportFrame(payload(binding)))
  assert.throws(() => parseServerTransportFrame(payload({ ...binding, agentKey: 42 })), /Invalid Server/)
  assert.throws(() => parseServerTransportFrame(payload({ ...binding, projectId: 42 })), /Invalid Server/)
  const { agentKey: _, ...missing } = binding
  assert.throws(() => parseServerTransportFrame(payload(missing)), /Invalid Server/)
})

test('parses blob fetch and reconcile report in their correct directions', () => {
  assert.doesNotThrow(() => parseWorkerTransportFrame(durable({ type: 'resource.blob.fetch', action: 'request', requestId: 'blob-1', sha256: hash })))
  assert.doesNotThrow(() => parseServerTransportFrame(durable({ type: 'resource.blob.fetch', action: 'response', requestId: 'blob-1', sha256: hash, mediaType: 'text/plain', size: 3, base64Content: 'YWJj' })))
  assert.doesNotThrow(() => parseWorkerTransportFrame(durable({ type: 'resource.reconcile.report', report: { requestId: 'report-1', workerId: 'worker-1', resourceSetRevision: 2, bindingId: 'binding-1', bindingRevision: 1, resourceRevisionId: 'revision-1', resourceId: 'resource-1', kind: 'skill', integrity: hash, result: 'installed', phase: 'ready', progressBytes: 3, errorCode: null, message: null, activeRevision: 1, previousRevision: null, occurredAt: now } })))
})

test('rejects invalid hashes, unknown fields and wrong directions', () => {
  assert.throws(() => parseWorkerTransportFrame(durable({ type: 'resource.blob.fetch', action: 'request', requestId: 'blob-1', sha256: 'bad' })), /Invalid Worker/)
  assert.throws(() => parseServerTransportFrame(durable({ type: 'resource.set.notify', workerId: 'worker-1', setRevision: 2, fingerprint: hash, resources: [], extra: true })), /Invalid Server/)
  assert.throws(() => parseServerTransportFrame(durable({ type: 'resource.blob.fetch', action: 'request', requestId: 'blob-1', sha256: hash })), /Invalid Server/)
})
