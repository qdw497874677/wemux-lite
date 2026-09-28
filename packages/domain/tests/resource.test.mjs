import test from 'node:test'
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
