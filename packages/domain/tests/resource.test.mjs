import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import {
  assertResourceBindingTransition,
  assertResourceRevisionImmutable,
  assertResourceRevisionValid,
  assertTrustedRegistryPackage,
  canTransitionResourceBinding,
} from '../dist/index.js'

const hash = 'a'.repeat(64)
const now = '2026-04-01T00:00:00.000Z'
const manifest = {
  schemaVersion: 1,
  name: 'review',
  description: 'review skill',
  compatibility: { workerProtocol: '2.0', platforms: ['linux'], architectures: ['x64'], agentKeys: ['pi'] },
  bytes: 3,
  fileCount: 1,
  sha256: hash,
  materializerVersion: 1,
  restartPolicy: 'none',
}
const skillRevision = {
  id: 'revision-1', resourceId: 'resource-1', kind: 'skill', version: 1, state: 'published', manifest,
  payload: { mode: 'blobs', files: [{ path: 'SKILL.md', size: 3, mediaType: 'text/markdown', sha256: hash, blobSha256: hash }] },
  contentSha256: hash, supplyChain: { mode: 'static-content', manifestSha256: hash }, createdBy: 'user-1', createdAt: now,
}

test('validates immutable static skill revisions and manifest hashes', () => {
  assert.doesNotThrow(() => assertResourceRevisionValid(skillRevision))
  assert.doesNotThrow(() => assertResourceRevisionImmutable(skillRevision, structuredClone(skillRevision)))
  assert.throws(() => assertResourceRevisionImmutable(skillRevision, { ...skillRevision, version: 2 }), /resource_revision_immutable/)
  assert.throws(() => assertResourceRevisionValid({ ...skillRevision, contentSha256: 'b'.repeat(64) }), /skill_manifest_hash_mismatch/)
  assert.throws(() => assertResourceRevisionValid({ ...skillRevision, payload: { mode: 'blobs', files: [{ ...skillRevision.payload.files[0], path: '../escape' }] } }), /invalid_skill_file/)
})

test('model provider revision accepts only non-secret environment locators and consistent integrity', () => {
  const config = { providerKey: 'openai-compatible', endpoint: 'https://models.example.test/v1', modelIds: ['test-model'], agentKeys: ['pi'], credential: { kind: 'environment', variableNames: ['OPENAI_API_KEY'] } }
  const integrity = createHash('sha256').update(JSON.stringify(config)).digest('hex')
  const revision = { ...skillRevision, id: 'provider-rev-1', kind: 'model-provider', contentSha256: integrity, payload: { mode: 'inline-config', contentSha256: integrity, config }, manifest: { ...manifest, bytes: Buffer.byteLength(JSON.stringify(config)), fileCount: 0, sha256: integrity }, supplyChain: { mode: 'static-content', manifestSha256: integrity } }
  assert.doesNotThrow(() => assertResourceRevisionValid(revision))
  const local = { ...config, credential: { kind: 'worker-credential', credentialRef: 'local-key', variableNames: ['OPENAI_API_KEY'] } }
  const localHash = createHash('sha256').update(JSON.stringify(local)).digest('hex')
  assert.doesNotThrow(() => assertResourceRevisionValid({ ...revision, contentSha256: localHash, payload: { ...revision.payload, contentSha256: localHash, config: local }, manifest: { ...revision.manifest, bytes: Buffer.byteLength(JSON.stringify(local)), sha256: localHash }, supplyChain: { ...revision.supplyChain, manifestSha256: localHash } }))
  for (const badConfig of [{ ...config, apiKey: 'sentinel-secret' }, { ...config, endpoint: 'https://key@models.example.test/v1' }, { ...config, credential: { kind: 'environment', variableNames: ['BAD-NAME'] } }, { ...config, credential: { kind: 'environment', variableNames: ['PATH'] } }, { ...config, credential: { kind: 'environment', variableNames: ['HOME'] } }, { ...config, credential: { kind: 'environment', variableNames: ['NODE_OPTIONS'] } }, { ...config, credential: { kind: 'environment', variableNames: ['PI_CODING_AGENT_DIR'] } }, { ...config, credential: { kind: 'environment', variableNames: ['LD_PRELOAD'] } }, { ...config, credential: { kind: 'worker-credential', credentialRef: 'local-key', variableNames: ['OPENAI_API_KEY'], secret: 'sentinel-secret' } }, { ...config, credential: { kind: 'worker-credential', credentialRef: '../escape', variableNames: ['OPENAI_API_KEY'] } }, { ...config, credential: { kind: 'worker-credential', credentialRef: 'local-key' } }]) {
    assert.throws(() => assertResourceRevisionValid({ ...revision, payload: { ...revision.payload, config: badConfig } }), /invalid_provider/)
  }
  assert.throws(() => assertResourceRevisionValid({ ...revision, payload: { ...revision.payload, config: { ...config, modelIds: ['another'] } } }), /provider_config_hash_mismatch/)
  assert.throws(() => assertResourceRevisionValid({ ...revision, payload: { ...revision.payload, credentialValue: 'sentinel-secret' } }), /invalid_provider_payload/)
  assert.throws(() => assertResourceRevisionValid({ ...revision, manifest: { ...revision.manifest, credentialValue: 'sentinel-secret' } }), /invalid_provider_manifest/)
  assert.throws(() => assertResourceRevisionValid({ ...revision, supplyChain: { ...revision.supplyChain, credentialValue: 'sentinel-secret' } }), /invalid_provider_supply_chain/)
})

test('accepts only exact packages from trusted registry origins', () => {
  const trusted = { mode: 'registry-package', packageName: '@earendil-works/pi-coding-agent', packageVersion: '0.52.12', registryOrigin: 'https://registry.npmjs.org', packageIntegrity: 'sha512-YWJjZA==' }
  assert.doesNotThrow(() => assertTrustedRegistryPackage(trusted))
  assert.throws(() => assertTrustedRegistryPackage({ ...trusted, packageVersion: '^0.52.12' }), /package_version_must_be_exact/)
  assert.throws(() => assertTrustedRegistryPackage({ ...trusted, registryOrigin: 'https://evil.example' }), /untrusted_registry_origin/)
  assert.throws(() => assertTrustedRegistryPackage({ ...trusted, packageName: 'https://evil.example/runtime.tgz' }), /invalid_package_name/)
})

test('enforces the resource binding lifecycle including pending gc', () => {
  assert.equal(canTransitionResourceBinding('assigned', 'notified'), true)
  assert.equal(canTransitionResourceBinding('installed', 'pending-gc'), true)
  assert.equal(canTransitionResourceBinding('pending-gc', "gc'd"), true)
  assert.equal(canTransitionResourceBinding("gc'd", 'installed'), false)
  assert.throws(() => assertResourceBindingTransition('assigned', 'installed'), /invalid_resource_binding_transition/)
})
