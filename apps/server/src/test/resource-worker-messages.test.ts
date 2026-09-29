import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Resource, ResourceRevision, Timestamp, UserId, WorkerId } from '@wemux/domain'
import { ResourceService } from '../application/resource-service.ts'
import { SqliteResourceRepository } from '../storage/sqlite-resource-repository.ts'
import { ResourceBlobStore } from '../storage/resource-blob-store.ts'
import { WorkerService } from '../application/worker-service.ts'

const at = '2026-01-01T00:00:00.000Z' as Timestamp
const actor = 'user-1' as UserId
const workerId = 'worker-1' as WorkerId
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

function resourceFixture(content = '# skill') {
  const contentHash = sha(content), manifestHash = sha('manifest')
  const resource: Resource = { id: 'skill-1', kind: 'skill', name: 'Skill', description: '', definition: { entryFile: 'SKILL.md', compatibleAgents: [], containsExecutableFiles: false }, createdBy: actor, createdAt: at, updatedAt: at }
  const revision: ResourceRevision = { id: 'rev-1', resourceId: resource.id, kind: 'skill', version: 1, state: 'published', manifest: { schemaVersion: 1, name: 'Skill', description: '', compatibility: { workerProtocol: '2', platforms: [], architectures: [], agentKeys: [] }, bytes: Buffer.byteLength(content), fileCount: 1, sha256: manifestHash, materializerVersion: 1, restartPolicy: 'none' }, payload: { mode: 'blobs', files: [{ path: 'SKILL.md', size: Buffer.byteLength(content), mediaType: 'text/markdown', sha256: contentHash, blobSha256: contentHash }] }, contentSha256: manifestHash, supplyChain: { mode: 'static-content', manifestSha256: manifestHash }, createdBy: actor, createdAt: at }
  return { resource, revision, content, contentHash, manifestHash }
}

function fakeServerStore() {
  const worker = { id: workerId, connectionState: 'online', lastSeenAt: at } as never
  const resources = { getWorker: async () => worker, saveWorker: async () => undefined }
  return {
    resources,
    transaction: async <T>(work: (tx: { resources: typeof resources }) => Promise<T>) => work({ resources }),
  } as never
}

test('Worker report 被持久化并投影 phase，ready 后更新 binding 状态', async () => {
  const repository = new SqliteResourceRepository(':memory:')
  const blobsRoot = await mkdtemp(join(tmpdir(), 'wemux-server-resource-'))
  try {
    const service = new ResourceService(repository, { send: () => undefined }, () => at, new ResourceBlobStore(blobsRoot))
    const fixture = resourceFixture()
    service.createResource(fixture.resource); service.createRevision(fixture.revision)
    const created = service.createBinding({ id: 'binding-1', workerId, resourceRevisionId: fixture.revision.id, createdBy: actor })
    const desired = service.desiredSet(workerId)
    assert.equal(desired.bindings[0]?.bindingRevision, created.revision, 'snapshot 必须携带已通知的 binding revision')
    const worker = new WorkerService(fakeServerStore(), { session: () => undefined } as never, undefined, undefined, service, null)
    const progress = { requestId: 'report-progress', workerId, resourceSetRevision: desired.revision, bindingId: created.id, bindingRevision: desired.bindings[0]!.bindingRevision, resourceRevisionId: fixture.revision.id, resourceId: fixture.resource.id, kind: 'skill' as const, integrity: fixture.manifestHash, result: 'installed' as const, phase: 'downloading' as const, progressBytes: 3, errorCode: null, message: null, activeRevision: null, previousRevision: null, occurredAt: at }
    await worker.receive(workerId, { type: 'resource.reconcile.report', report: progress })
    assert.equal(service.bindings(workerId)[0]!.status, 'notified')
    assert.equal(service.bindingProjections(workerId)[0]!.reconcile?.phase, 'downloading')
    await worker.receive(workerId, { type: 'resource.reconcile.report', report: { ...progress, requestId: 'report-ready', phase: 'ready', occurredAt: '2026-01-01T00:00:01.000Z' as Timestamp } })
    assert.equal(service.bindings(workerId)[0]!.status, 'installed')
    assert.equal(service.bindingProjections(workerId)[0]!.reconcile?.phase, 'ready')
    const installed = service.bindings(workerId)[0]!
    service.transitionBinding(installed.id, 'pending-gc', installed.revision)
    await worker.receive(workerId, { type: 'resource.reconcile.report', report: { ...progress, requestId: 'stale-installed', phase: 'ready', occurredAt: '2026-01-01T00:00:02.000Z' as Timestamp } })
    assert.equal(service.bindings(workerId)[0]!.status, 'pending-gc', '旧安装报告不得覆盖撤销意图')
    assert.equal(service.bindingProjections(workerId)[0]!.reconcile?.requestId, 'report-ready', '旧安装报告不得覆盖投影')
    await worker.receive(workerId, { type: 'resource.reconcile.report', report: { ...progress, requestId: 'removed-ack', result: 'pending-gc', phase: 'gc', occurredAt: '2026-01-01T00:00:03.000Z' as Timestamp } })
    assert.equal(service.bindingProjections(workerId)[0]!.reconcile?.requestId, 'removed-ack', '移除报告虽引用旧 snapshot 仍应接收')
  } finally { repository.close(); await rm(blobsRoot, { recursive: true, force: true }) }
})

test('Agent runtime binding pins Agent identity and exact official artifact in desired set', () => {
  const repository = new SqliteResourceRepository(':memory:')
  try {
    const service = new ResourceService(repository, { send: () => undefined }, () => at)
    const artifact = { mode: 'artifact' as const, packageName: '@earendil-works/pi-coding-agent', packageVersion: '0.85.1', registryOrigin: 'https://registry.npmjs.org', packageIntegrity: 'sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==' }
    const integrity = sha('runtime-manifest')
    const resource: Resource = { id: 'pi-runtime', kind: 'agent-runtime', name: 'Pi', description: '', definition: {}, createdBy: actor, createdAt: at, updatedAt: at }
    const revision: ResourceRevision = { id: 'pi-0.85.1', resourceId: resource.id, kind: 'agent-runtime', version: 1, state: 'published', manifest: { schemaVersion: 1, name: 'Pi', description: '', compatibility: { workerProtocol: '2', platforms: ['linux'], architectures: ['x64'], agentKeys: ['pi' as never] }, bytes: 0, fileCount: 0, sha256: integrity, materializerVersion: 1, restartPolicy: 'worker' }, payload: artifact, contentSha256: integrity, supplyChain: { mode: 'registry-package', packageName: artifact.packageName, packageVersion: artifact.packageVersion, registryOrigin: artifact.registryOrigin, packageIntegrity: artifact.packageIntegrity }, createdBy: actor, createdAt: at }
    service.createResource(resource); service.createRevision(revision)
    for (const invalid of [{ agentKey: null }, { agentKey: 'claude-code' as never }, { agentKey: 'pi' as never, projectId: 'project-1' as never }]) {
      assert.throws(() => service.createBinding({ workerId, resourceRevisionId: revision.id, createdBy: actor, ...invalid }), /invalid_runtime_binding/)
    }
    service.createBinding({ workerId, resourceRevisionId: revision.id, agentKey: 'pi' as never, createdBy: actor })
    const binding = service.desiredSet(workerId).bindings[0]!
    assert.deepEqual(binding.artifact, artifact)
    assert.equal(binding.agentKey, 'pi')
    assert.equal(binding.projectId, null)
    assert.deepEqual(binding.files, [])
  } finally { repository.close() }
})

test('blob fetch 按 hash 返回内容，不存在时返回 not-found', async () => {
  const repository = new SqliteResourceRepository(':memory:')
  const root = await mkdtemp(join(tmpdir(), 'wemux-server-resource-'))
  try {
    const blobs = new ResourceBlobStore(root)
    const content = Buffer.from('# blob')
    const contentHash = sha(content)
    await blobs.put(content, contentHash)
    const worker = new WorkerService(fakeServerStore(), { session: () => undefined } as never, undefined, undefined, null, blobs)
    const found = await worker.receive(workerId, { type: 'resource.blob.fetch', action: 'request', requestId: 'blob-1', sha256: contentHash })
    assert.deepEqual(found, [{ type: 'resource.blob.fetch', action: 'response', requestId: 'blob-1', sha256: contentHash, mediaType: 'application/octet-stream', size: content.length, base64Content: content.toString('base64') }])
    const missingHash = sha('missing')
    assert.deepEqual(await worker.receive(workerId, { type: 'resource.blob.fetch', action: 'request', requestId: 'blob-2', sha256: missingHash }), [{ type: 'resource.blob.fetch', action: 'not-found', requestId: 'blob-2', sha256: missingHash }])
  } finally { repository.close(); await rm(root, { recursive: true, force: true }) }
})
