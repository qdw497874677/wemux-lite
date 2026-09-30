import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { AgentKey, NodeResourcePresetEntry, Resource, ResourceRevision, Timestamp, UserId, WorkerId } from '@wemux/domain'
import { ResourceService } from '../application/resource-service.ts'
import { SqliteResourceRepository } from '../storage/sqlite-resource-repository.ts'

const at = '2026-04-01T00:00:00.000Z' as Timestamp
const admin = 'admin-1' as UserId
const worker = 'worker-1' as WorkerId
const hash = createHash('sha256').update('skill').digest('hex')
const resource: Resource = { id: 'skill-1', kind: 'skill', name: 'Review', description: '', definition: { entryFile: 'SKILL.md', compatibleAgents: [], containsExecutableFiles: false }, createdBy: admin, createdAt: at, updatedAt: at }
const revision: ResourceRevision = { id: 'skill-rev-1', resourceId: resource.id, kind: 'skill', version: 1, state: 'published', manifest: { schemaVersion: 1, name: 'Review', description: '', compatibility: { workerProtocol: '2', platforms: ['linux'], architectures: ['x64'], agentKeys: [] }, bytes: 5, fileCount: 1, sha256: hash, materializerVersion: 1, restartPolicy: 'none' }, payload: { mode: 'blobs', files: [{ path: 'SKILL.md', size: 5, mediaType: 'text/markdown', sha256: hash, blobSha256: hash }] }, supplyChain: { mode: 'static-content', manifestSha256: hash }, contentSha256: hash, createdBy: admin, createdAt: at }
const entry: NodeResourcePresetEntry = { resourceId: resource.id, resourceRevisionId: revision.id, agentKey: null, projectId: null, required: true }

function setup() {
  const repository = new SqliteResourceRepository(':memory:')
  repository.createResource(resource); repository.createRevision(revision)
  const notifications: unknown[] = []
  const service = new ResourceService(repository, { send: (id, payload) => notifications.push({ id, payload }) }, () => at)
  return { repository, service, notifications }
}

test('instance Preset publishes immutable CAS versions with manual application only', () => {
  const { repository, service } = setup()
  try {
    assert.throws(() => service.createPreset({ id: 'standard', name: '标准节点', description: '', expectedRevision: 0, entries: [entry], autoApply: { enabled: true }, createdBy: admin }), /preset_auto_apply_unavailable/)
    assert.throws(() => service.createPreset({ id: 'standard', name: '标准节点', description: '', expectedRevision: 0, entries: [{ ...entry, resourceRevisionId: 'missing' }], createdBy: admin }), /preset_revision_not_published/)
    assert.throws(() => service.createPreset({ id: 'standard', name: '标准节点', description: '', expectedRevision: 0, entries: [entry, { ...entry, agentKey: 'pi' as AgentKey }], createdBy: admin }), /duplicate_preset_entry/, 'same revision cannot be bound twice to one Worker')
    const first = service.createPreset({ id: 'standard', name: '标准节点', description: '', expectedRevision: 0, entries: [entry], createdBy: admin })
    assert.equal(first.revision, 1)
    assert.deepEqual(first.autoApply, { enabled: false })
    assert.throws(() => service.createPreset({ id: 'standard', name: '过期写入', description: '', expectedRevision: 0, entries: [entry], createdBy: admin }), /preset_revision_conflict/)
    const second = service.createPreset({ id: 'standard', name: '新版本', description: '', expectedRevision: 1, entries: [entry], createdBy: admin })
    assert.deepEqual(repository.preset('standard', 1), first)
    assert.deepEqual(repository.preset('standard', 2), second)
  } finally { repository.close() }
})

test('manual Preset application creates one atomic ResourceSet revision and idempotent bindings', async () => {
  const { repository, service, notifications } = setup()
  try {
    const secondResource = { ...resource, id: 'skill-2' }
    const secondRevision = { ...revision, id: 'skill-rev-2', resourceId: secondResource.id }
    repository.createResource(secondResource); repository.createRevision(secondRevision)
    service.createPreset({ id: 'standard', name: '标准节点', description: '', expectedRevision: 0, entries: [entry, { ...entry, resourceId: secondResource.id, resourceRevisionId: secondRevision.id, required: false }], createdBy: admin })
    const input = { presetId: 'standard', presetRevision: 1, workerId: worker, requestId: 'apply-1', expectedSetRevision: 0, createdBy: admin }
    const first = await service.applyPreset(input)
    assert.equal(first.bindingIds.length, 2)
    assert.equal(service.desiredSet(worker).revision, 1, 'multi-entry apply creates only one desired revision')
    assert.equal(notifications.length, 1)
    const again = await service.applyPreset(input)
    assert.deepEqual(again, first)
    assert.equal(notifications.length, 1, 'idempotent replay does not enqueue notification')
    assert.equal(service.presetApplications(worker)[0]?.items.length, 2)
    await assert.rejects(service.applyPreset({ ...input, workerId: 'other' as WorkerId }), /preset_application_request_conflict/)
    await assert.rejects(service.applyPreset({ ...input, requestId: 'apply-2', expectedSetRevision: 0 }), /resource_set_revision_conflict/)
    await assert.rejects(service.applyPreset({ ...input, requestId: 'apply-3', expectedSetRevision: 1 }), /preset_binding_conflict/)
    assert.equal(repository.bindings(worker).length, 2)
    assert.equal(notifications.length, 1)
    service.createPreset({ id: 'alternate', name: '重复版本', description: '', expectedRevision: 0, entries: [{ ...entry, agentKey: 'pi' as AgentKey }], createdBy: admin })
    await assert.rejects(service.applyPreset({ ...input, presetId: 'alternate', requestId: 'apply-4', expectedSetRevision: 1 }), /preset_binding_conflict/, 'existing revision cannot be rebound with different scope')
  } finally { repository.close() }
})

test('model-provider preset only binds mapped Agent and distributes locator without a secret', async () => {
  const { repository, service } = setup()
  try {
    const config = { providerKey: 'openai-compatible' as const, endpoint: 'https://models.example.test/v1', modelIds: ['test-model'], agentKeys: ['pi' as AgentKey], credential: { kind: 'environment' as const, variableNames: ['OPENAI_API_KEY'] } }
    const integrity = createHash('sha256').update(JSON.stringify(config)).digest('hex')
    const provider: Resource = { id: 'provider-1', kind: 'model-provider', name: 'Test model', description: '', definition: config, createdBy: admin, createdAt: at, updatedAt: at }
    const published: ResourceRevision = { id: 'provider-rev', resourceId: provider.id, kind: 'model-provider', version: 1, state: 'published', manifest: { ...revision.manifest, bytes: Buffer.byteLength(JSON.stringify(config)), fileCount: 0, sha256: integrity, compatibility: { ...revision.manifest.compatibility, agentKeys: ['pi' as AgentKey] } }, payload: { mode: 'inline-config', contentSha256: integrity, config }, contentSha256: integrity, supplyChain: { mode: 'static-content', manifestSha256: integrity }, createdBy: admin, createdAt: at }
    repository.createResource(provider); repository.createRevision(published)
    const entry = { resourceId: provider.id, resourceRevisionId: published.id, agentKey: 'pi' as AgentKey, projectId: null, required: true }
    assert.throws(() => service.createPreset({ name: 'Wrong Agent', description: '', expectedRevision: 0, entries: [{ ...entry, agentKey: 'claude-code' as AgentKey }], createdBy: admin }), /invalid_provider_binding/)
    assert.throws(() => service.createBinding({ workerId: worker, resourceRevisionId: published.id, agentKey: 'claude-code' as AgentKey, createdBy: admin }), /invalid_provider_binding/)
    service.createPreset({ id: 'models', name: 'Model provider', description: '', expectedRevision: 0, entries: [entry], createdBy: admin })
    await service.applyPreset({ presetId: 'models', presetRevision: 1, workerId: worker, requestId: 'apply-models', expectedSetRevision: 0, createdBy: admin })
    const binding = service.desiredSet(worker).bindings[0]
    assert.equal(binding?.kind, 'model-provider')
    assert.deepEqual(binding?.provider?.config.credential, { kind: 'environment', variableNames: ['OPENAI_API_KEY'] })
    assert.doesNotMatch(JSON.stringify(service.desiredSet(worker)), /sentinel-secret/)
    const localConfig = { ...config, credential: { kind: 'worker-credential' as const, credentialRef: 'worker-ref-1', variableNames: ['OPENAI_API_KEY'] } }
    const localHash = createHash('sha256').update(JSON.stringify(localConfig)).digest('hex')
    const localProvider: Resource = { ...provider, id: 'provider-local', definition: localConfig }
    const localRevision: ResourceRevision = { ...published, id: 'provider-local-rev', resourceId: localProvider.id, contentSha256: localHash, payload: { mode: 'inline-config', contentSha256: localHash, config: localConfig }, manifest: { ...published.manifest, bytes: Buffer.byteLength(JSON.stringify(localConfig)), sha256: localHash }, supplyChain: { mode: 'static-content', manifestSha256: localHash } }
    repository.createResource(localProvider); repository.createRevision(localRevision)
    service.createPreset({ id: 'models-local', name: 'Local model credential', description: '', expectedRevision: 0, entries: [{ ...entry, resourceId: localProvider.id, resourceRevisionId: localRevision.id }], createdBy: admin })
    await service.applyPreset({ presetId: 'models-local', presetRevision: 1, workerId: worker, requestId: 'apply-models-local', expectedSetRevision: 1, createdBy: admin })
    assert.deepEqual(service.desiredSet(worker).bindings.find(item => item.resourceId === localProvider.id)?.provider?.config.credential, localConfig.credential)
    assert.doesNotMatch(JSON.stringify(service.desiredSet(worker)), /sentinel-secret/)
  } finally { repository.close() }
})

test('project-scoped Provider candidates expose no secrets and never claim model availability', () => {
  const { repository, service } = setup()
  try {
    const config = { providerKey: 'openai-compatible' as const, endpoint: 'https://models.example.test/v1', modelIds: ['model-a'], agentKeys: ['pi' as AgentKey], credential: { kind: 'worker-credential' as const, credentialRef: 'private-ref', variableNames: ['OPENAI_API_KEY'] } }
    const digest = createHash('sha256').update(JSON.stringify(config)).digest('hex')
    const provider: Resource = { id: 'provider-candidate', kind: 'model-provider', name: 'Candidate', description: '', definition: config, createdBy: admin, createdAt: at, updatedAt: at }
    const published: ResourceRevision = { id: 'candidate-rev', resourceId: provider.id, kind: 'model-provider', version: 1, state: 'published', manifest: { ...revision.manifest, bytes: Buffer.byteLength(JSON.stringify(config)), fileCount: 0, sha256: digest, compatibility: { ...revision.manifest.compatibility, agentKeys: ['pi' as AgentKey] } }, payload: { mode: 'inline-config', contentSha256: digest, config }, contentSha256: digest, supplyChain: { mode: 'static-content', manifestSha256: digest }, createdBy: admin, createdAt: at }
    repository.createResource(provider); repository.createRevision(published)
    service.createBinding({ workerId: worker, resourceRevisionId: published.id, agentKey: 'pi' as AgentKey, projectId: 'project-a' as never, createdBy: admin })
    assert.deepEqual(service.providerCandidates(worker, 'project-b' as never, 'pi' as AgentKey), [])
    assert.deepEqual(service.providerCandidates('other-worker' as WorkerId, 'project-a' as never, 'pi' as AgentKey), [])
    assert.deepEqual(service.providerCandidates(worker, 'project-a' as never, 'claude-code' as AgentKey), [])
    const items = service.providerCandidates(worker, 'project-a' as never, 'pi' as AgentKey)
    assert.deepEqual(items, [{ modelId: 'openai-compatible::model-a', resourceId: provider.id, bindingId: service.bindings(worker)[0]!.id, status: 'not-verified' }])
    assert.doesNotMatch(JSON.stringify(items), /private-ref|OPENAI_API_KEY|models\.example\.test|sentinel-secret/)
    service.transitionBinding(service.bindings(worker)[0]!.id, 'pending-gc', service.bindings(worker)[0]!.revision)
    assert.deepEqual(service.providerCandidates(worker, 'project-a' as never, 'pi' as AgentKey), [])
  } finally { repository.close() }
})

test('a failed multi-entry apply rolls back all bindings and emits no notification', async () => {
  const { repository, service, notifications } = setup()
  try {
    service.createPreset({ id: 'standard', name: '标准节点', description: '', expectedRevision: 0, entries: [entry], createdBy: admin })
    const original = repository.putResourceSet.bind(repository)
    repository.putResourceSet = () => { throw new Error('injected_commit_failure') }
    await assert.rejects(service.applyPreset({ presetId: 'standard', presetRevision: 1, workerId: worker, requestId: 'failed', expectedSetRevision: 0, createdBy: admin }), /injected_commit_failure/)
    repository.putResourceSet = original
    assert.equal(repository.bindings(worker).length, 0)
    assert.equal(repository.presetApplication('failed'), null)
    assert.equal(notifications.length, 0)
    const result = await service.applyPreset({ presetId: 'standard', presetRevision: 1, workerId: worker, requestId: 'failed', expectedSetRevision: 0, createdBy: admin })
    assert.equal(result.bindingIds.length, 1)
  } finally { repository.close() }
})
