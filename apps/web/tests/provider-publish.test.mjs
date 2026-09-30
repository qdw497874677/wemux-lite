import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { prepareProviderRevision } from '../src/features/presets/provider-publish.ts'

const input = { resourceId: 'provider', revisionId: 'rev', name: 'Test Provider', endpoint: 'https://models.example.test/v1', modelId: 'test-model', credentialRef: 'local-ref', version: 1, createdBy: 'admin', createdAt: '2026-01-01T00:00:00Z' }
test('Provider publisher produces strict non-secret Pi revision with reproducible digest', () => {
  const { definition, revision } = prepareProviderRevision(input)
  const digest = createHash('sha256').update(JSON.stringify(definition)).digest('hex')
  assert.equal(revision.contentSha256, digest)
  assert.equal(revision.payload.mode, 'inline-config')
  assert.equal(revision.manifest.sha256, digest)
  assert.equal(revision.manifest.bytes, Buffer.byteLength(JSON.stringify(definition)))
  assert.equal(revision.supplyChain.manifestSha256, digest)
  assert.deepEqual(definition.credential, { kind: 'worker-credential', credentialRef: input.credentialRef, variableNames: ['OPENAI_API_KEY'] })
  assert.doesNotMatch(JSON.stringify({ definition, revision }), /apiKey|secret|ciphertext|password/)
})
test('Provider publisher rejects untrusted endpoint and locator fields without sending a request', () => {
  for (const invalid of [
    { endpoint: 'http://models.example.test/v1' }, { endpoint: 'https://u:p@models.example.test/v1' },
    { endpoint: 'https://models.example.test/v1?token=x' }, { modelId: '../bad' }, { credentialRef: '../escape' }, { credentialRef: '' },
  ]) assert.throws(() => prepareProviderRevision({ ...input, ...invalid }))
})
