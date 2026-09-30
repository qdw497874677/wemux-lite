import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Resource, ResourceRevision, Timestamp, UserId, WorkerId } from '@wemux/domain'
import { ResourceService } from '../application/resource-service.js'
import { ResourceBlobStore } from '../storage/resource-blob-store.js'
import { SqliteResourceRepository } from '../storage/sqlite-resource-repository.js'

const at = '2026-04-01T00:00:00.000Z' as Timestamp
const userId = 'user-1' as UserId
const workerId = 'worker-1' as WorkerId
const content = Buffer.from('abc')
const hash = createHash('sha256').update(content).digest('hex')
const resource: Resource = { id: 'resource-1', kind: 'skill', name: 'Review', description: 'Review skill', definition: { entryFile: 'SKILL.md', compatibleAgents: [], containsExecutableFiles: false }, createdBy: userId, createdAt: at, updatedAt: at }
const revision: ResourceRevision = {
  id: 'revision-1', resourceId: resource.id, kind: 'skill', version: 1, state: 'published',
  manifest: { schemaVersion: 1, name: resource.name, description: resource.description, compatibility: { workerProtocol: '2.0', platforms: ['linux'], architectures: ['x64'], agentKeys: [] }, bytes: content.length, fileCount: 1, sha256: hash, materializerVersion: 1, restartPolicy: 'none' },
  payload: { mode: 'blobs', files: [{ path: 'SKILL.md', size: content.length, mediaType: 'text/markdown', sha256: hash, blobSha256: hash }] },
  contentSha256: hash, supplyChain: { mode: 'static-content', manifestSha256: hash }, createdBy: userId, createdAt: at,
}

test('resource migration is idempotent and revisions stay immutable after reopen', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-resource-repository-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'server.sqlite')
  const first = new SqliteResourceRepository(path)
  first.migrate(); first.migrate()
  first.createResource(resource)
  first.createRevision(revision)
  assert.deepEqual(first.createRevision(revision), revision)
  assert.throws(() => first.createRevision({ ...revision, version: 2 }), /resource_revision_immutable/)
  assert.throws(() => first.assertRevisionUnchanged({ ...revision, version: 2 }), /resource_revision_immutable/)
  first.close()
  const reopened = new SqliteResourceRepository(path)
  assert.deepEqual(reopened.revision(revision.id), revision)
  assert.throws(() => reopened.createRevision({ ...revision, id: 'revision-other' }), /UNIQUE constraint failed/)
  reopened.close()
})

test('service updates desired set once per bounded domain event and enforces binding transitions', () => {
  const repository = new SqliteResourceRepository(':memory:')
  repository.createResource(resource); repository.createRevision(revision)
  const notifications: unknown[] = []
  const service = new ResourceService(repository, { send: (_workerId, payload) => { notifications.push(payload) } }, () => at)
  const binding = service.createBinding({ id: 'binding-1', workerId, resourceRevisionId: revision.id, createdBy: userId })
  assert.equal(binding.status, 'notified')
  assert.equal(service.desiredSet(workerId).revision, 1)
  assert.equal(notifications.length, 1)
  service.refreshDesiredSet(workerId)
  assert.equal(notifications.length, 1, '相同期望态不重复入队')
  assert.throws(() => service.transitionBinding(binding.id, 'installed', 1), /resource_binding_revision_conflict/)
  const installed = service.transitionBinding(binding.id, 'installed', binding.revision)
  const pending = service.transitionBinding(binding.id, 'pending-gc', installed.revision)
  assert.equal(pending.status, 'pending-gc')
  assert.equal(service.desiredSet(workerId).bindings.length, 0)
  assert.equal(notifications.length, 2)
  repository.close()
})

test('model provider resource rejects secret fields and its revision is immutable', () => {
  const repository = new SqliteResourceRepository(':memory:')
  const config = { providerKey: 'openai-compatible' as const, endpoint: 'https://models.example.test/v1', modelIds: ['test-model'], agentKeys: ['pi' as never], credential: { kind: 'environment' as const, variableNames: ['OPENAI_API_KEY'] } }
  const digest = createHash('sha256').update(JSON.stringify(config)).digest('hex')
  const provider: Resource = { ...resource, id: 'provider-1', kind: 'model-provider', definition: config }
  const published: ResourceRevision = { ...revision, id: 'provider-rev-1', resourceId: provider.id, kind: 'model-provider', contentSha256: digest, payload: { mode: 'inline-config', contentSha256: digest, config }, manifest: { ...revision.manifest, bytes: Buffer.byteLength(JSON.stringify(config)), fileCount: 0, sha256: digest, compatibility: { ...revision.manifest.compatibility, agentKeys: ['pi' as never] } }, supplyChain: { mode: 'static-content', manifestSha256: digest } }
  try {
    assert.throws(() => repository.createResource({ ...provider, definition: { ...config, apiKey: 'sentinel-secret' } } as unknown as Resource), /invalid_provider_config/)
    repository.createResource(provider)
    assert.throws(() => repository.createRevision({ ...published, payload: { mode: 'inline-config', contentSha256: digest, config: { ...config, modelIds: ['other'] } } }), /provider_config_hash_mismatch/)
    assert.throws(() => repository.createRevision({ ...published, payload: { mode: 'inline-config', contentSha256: digest, config: { ...config, modelIds: ['other'] } }, manifest: { ...published.manifest, bytes: Buffer.byteLength(JSON.stringify({ ...config, modelIds: ['other'] })) } }), /provider_config_hash_mismatch/, 'repository checks the actual digest even if bytes are internally consistent')
    assert.throws(() => repository.createRevision({ ...published, manifest: { ...published.manifest, credentialValue: 'sentinel-secret' } } as unknown as ResourceRevision), /invalid_provider_manifest/)
    assert.throws(() => repository.createRevision({ ...published, supplyChain: { ...published.supplyChain, credentialValue: 'sentinel-secret' } } as unknown as ResourceRevision), /invalid_provider_supply_chain/)
    assert.throws(() => repository.createRevision({ ...published, manifest: { ...published.manifest, compatibility: { ...published.manifest.compatibility, credentialValue: 'sentinel-secret' } } } as unknown as ResourceRevision), /invalid_provider_manifest/)
    assert.deepEqual(repository.createRevision(published), published)
    assert.throws(() => repository.createRevision({ ...published, version: 2 }), /resource_revision_immutable/)
    assert.doesNotMatch(JSON.stringify(repository.resources()) + JSON.stringify(repository.revisions(provider.id)), /sentinel-secret/)
  } finally { repository.close() }
})

test('filesystem blob store verifies hashes and deduplicates by content address', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wemux-resource-blobs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ResourceBlobStore(root)
  const first = await store.put(content, hash)
  const second = await store.put(content, hash)
  assert.equal(first.deduplicated, false)
  assert.equal(second.deduplicated, true)
  assert.deepEqual(await store.get(hash), content)
  await assert.rejects(store.put(content, 'b'.repeat(64)), /resource_blob_hash_mismatch/)
})
