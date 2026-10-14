import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { AgentCapability, AgentKey, ReconcileReport, Resource, ResourceRevision, Timestamp, UserId, WorkerId } from '@wemux/domain'
import { ResourceService } from '../application/resource-service.js'
import { ResourceInventoryService } from '../application/resource-inventory-service.js'
import { SqliteResourceRepository } from '../storage/sqlite-resource-repository.js'
import type { Worker } from '@wemux/server-domain'

const at = '2026-05-01T00:00:00.000Z' as Timestamp
const actor = 'user-1' as UserId
const onlineId = 'worker-online' as WorkerId
const offlineId = 'worker-offline' as WorkerId
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

const providerConfig = {
  providerKey: 'openai-compatible' as const,
  endpoint: 'https://models.example.test/v1',
  modelIds: ['cluster-model'],
  agentKeys: ['pi' as AgentKey],
  credential: { kind: 'environment' as const, variableNames: ['OPENAI_API_KEY'] },
}

function skillRevision(content: Buffer, hash: string): { resource: Resource; revision: ResourceRevision } {
  const resource: Resource = { id: 'skill-1', kind: 'skill', name: '评审', description: '代码评审技能', definition: { entryFile: 'SKILL.md', compatibleAgents: ['pi' as AgentKey], containsExecutableFiles: false }, createdBy: actor, createdAt: at, updatedAt: at }
  const revision: ResourceRevision = {
    id: 'skill-rev-1', resourceId: resource.id, kind: 'skill', version: 1, state: 'published',
    manifest: { schemaVersion: 1, name: resource.name, description: resource.description, compatibility: { workerProtocol: '2.0', platforms: ['linux'], architectures: ['x64'], agentKeys: ['pi' as AgentKey] }, bytes: content.length, fileCount: 1, sha256: hash, materializerVersion: 1, restartPolicy: 'none' },
    payload: { mode: 'blobs', files: [{ path: 'SKILL.md', size: content.length, mediaType: 'text/markdown', sha256: hash, blobSha256: hash }] },
    contentSha256: hash, supplyChain: { mode: 'static-content', manifestSha256: hash }, createdBy: actor, createdAt: at,
  }
  return { resource, revision }
}

function providerRevision(): { resource: Resource; revision: ResourceRevision } {
  const digest = sha(JSON.stringify(providerConfig))
  const resource: Resource = { id: 'provider-1', kind: 'model-provider', name: '集群模型', description: '集群托管模型网关', definition: providerConfig, createdBy: actor, createdAt: at, updatedAt: at }
  const revision: ResourceRevision = {
    id: 'provider-rev-1', resourceId: resource.id, kind: 'model-provider', version: 1, state: 'published',
    manifest: { schemaVersion: 1, name: resource.name, description: resource.description, compatibility: { workerProtocol: '2', platforms: ['linux'], architectures: ['x64'], agentKeys: ['pi' as AgentKey] }, bytes: Buffer.byteLength(JSON.stringify(providerConfig)), fileCount: 0, sha256: digest, materializerVersion: 1, restartPolicy: 'none' },
    payload: { mode: 'inline-config', contentSha256: digest, config: providerConfig },
    contentSha256: digest, supplyChain: { mode: 'static-content', manifestSha256: digest }, createdBy: actor, createdAt: at,
  }
  return { resource, revision }
}

function runtimeRevision(): { resource: Resource; revision: ResourceRevision } {
  const artifact = { mode: 'artifact' as const, packageName: '@earendil-works/pi-coding-agent', packageVersion: '0.85.1', registryOrigin: 'https://registry.npmjs.org', packageIntegrity: 'sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==' }
  const integrity = sha('runtime-manifest')
  const resource: Resource = { id: 'runtime-pi', kind: 'agent-runtime', name: '托管 Pi', description: '', definition: {}, createdBy: actor, createdAt: at, updatedAt: at }
  const revision: ResourceRevision = {
    id: 'runtime-pi-0.85.1', resourceId: resource.id, kind: 'agent-runtime', version: 1, state: 'published',
    manifest: { schemaVersion: 1, name: '托管 Pi', description: '', compatibility: { workerProtocol: '2', platforms: ['linux'], architectures: ['x64'], agentKeys: ['pi' as AgentKey] }, bytes: 0, fileCount: 0, sha256: integrity, materializerVersion: 1, restartPolicy: 'worker' },
    payload: artifact, contentSha256: integrity,
    supplyChain: { mode: 'registry-package', packageName: artifact.packageName, packageVersion: artifact.packageVersion, registryOrigin: artifact.registryOrigin, packageIntegrity: artifact.packageIntegrity }, createdBy: actor, createdAt: at,
  }
  return { resource, revision }
}

function capability(overrides: Partial<AgentCapability> & { agentKey: AgentKey }): AgentCapability {
  return { displayName: overrides.agentKey, version: '1.2.3', mode: 'execution', availability: { status: 'available' }, models: [], ...overrides }
}

function workerRecord(id: WorkerId, connectionState: Worker['connectionState'], capabilities: readonly AgentCapability[], extra: Partial<Worker> = {}): Worker {
  return { id, teamId: 'team-1' as never, ownerId: actor, name: `节点 ${id}`, shareScope: 'team' as never, connectionState, version: '2.0.0', platform: 'linux', capabilities, lastSeenAt: at, ...extra }
}

async function harness(workers: readonly Worker[]) {
  const repository = new SqliteResourceRepository(':memory:')
  const service = new ResourceService(repository, { send: () => undefined }, () => at)
  const inventory = new ResourceInventoryService(service, async () => workers, () => at)
  return { repository, service, inventory }
}

test('六类资源都被列出，Worker 条目按连接状态给出认证与可执行事实', async t => {
  const content = Buffer.from('SKILL')
  const { repository, service, inventory } = await harness([
    workerRecord(onlineId, 'online', [capability({ agentKey: 'pi' as AgentKey, version: '0.87.1', models: [{ modelId: 'runtime::fast' as never, displayName: 'Fast', source: 'configured' }] })]),
    workerRecord(offlineId, 'offline', []),
  ])
  t.after(() => repository.close())
  const skill = skillRevision(content, sha('SKILL'))
  service.createResource(skill.resource); service.createRevision(skill.revision)
  const provider = providerRevision()
  service.createResource(provider.resource); service.createRevision(provider.revision)

  const snapshot = await inventory.inventory()
  assert.equal(snapshot.generatedAt, at)
  assert.deepEqual(snapshot.workers.map(entry => entry.id), [onlineId, offlineId])
  assert.equal(snapshot.workers[1]!.connectionState, 'offline')

  const online = snapshot.workers[0]!
  assert.equal(online.configuration.state, 'configured')
  assert.equal(online.authentication.state, 'authenticated')
  assert.equal(online.execution.state, 'executable')
  assert.equal(online.distribution.state, 'not-distributed')
  assert.equal(online.distribution.detail, '没有分发给该 Worker 的资源')

  const offline = snapshot.workers[1]!
  assert.equal(offline.authentication.state, 'unknown')
  assert.equal(offline.execution.state, 'unknown')
  assert.match(offline.execution.detail, /离线/)

  assert.ok(snapshot.skills.some(entry => entry.id === 'skill-1'))
  assert.ok(snapshot.providers.some(entry => entry.id === 'provider-1'))
  assert.ok(snapshot.agents.length > 0)
  assert.ok(snapshot.models.length > 0)
})

test('未探测到的 Agent 也列出，且可执行状态为不可用而不是留空', async t => {
  const { repository, inventory } = await harness([workerRecord(onlineId, 'online', [capability({ agentKey: 'pi' as AgentKey })])])
  t.after(() => repository.close())
  const snapshot = await inventory.inventory()
  const keys = snapshot.agents.map(entry => `${entry.workerId}:${entry.agentKey}`)
  for (const key of ['pi', 'claude-code', 'codex', 'opencode']) assert.ok(keys.includes(`${onlineId}:${key}`), `缺少 ${key} 条目`)

  const codex = snapshot.agents.find(entry => entry.agentKey === 'codex')!
  assert.equal(codex.execution.state, 'unavailable')
  assert.equal(codex.execution.detail, 'Worker 未探测到该 Agent')
  assert.equal(codex.version, null)
  assert.equal(codex.authentication.state, 'unknown')
  assert.equal(codex.configuration.state, 'unconfigured')
})

test('可用但没有版本探测的 Agent 不得被展示为可执行，认证缺失不冒充已认证', async t => {
  const { repository, inventory } = await harness([
    workerRecord(onlineId, 'online', [
      capability({ agentKey: 'pi' as AgentKey, version: null }),
      capability({ agentKey: 'claude-code' as AgentKey, availability: { status: 'authentication-required', reason: '未登录' }, authorization: { state: 'unauthorized', instructions: '请先运行 claude login' } as never }),
      capability({ agentKey: 'opencode' as AgentKey, availability: { status: 'available' }, authorization: { state: 'unknown' } as never }),
    ]),
  ])
  t.after(() => repository.close())
  const snapshot = await inventory.inventory()
  const pi = snapshot.agents.find(entry => entry.agentKey === 'pi')!
  assert.equal(pi.execution.state, 'unavailable')
  assert.match(pi.execution.detail, /版本/)
  assert.equal(pi.authentication.state, 'unknown')
  assert.equal(pi.configuration.state, 'configured')

  const claude = snapshot.agents.find(entry => entry.agentKey === 'claude-code')!
  assert.equal(claude.authentication.state, 'unauthenticated')
  assert.equal(claude.authentication.detail, '请先运行 claude login')
  assert.equal(claude.execution.state, 'unavailable')

  const opencode = snapshot.agents.find(entry => entry.agentKey === 'opencode')!
  assert.equal(opencode.authentication.state, 'unknown')
  assert.notEqual(opencode.authentication.state, 'authenticated')
  assert.equal(opencode.execution.state, 'executable')
})

test('模型条目标注来源与真实可执行性，集群 Provider 声明的模型也列出', async t => {
  const { repository, service, inventory } = await harness([
    workerRecord(onlineId, 'online', [
      capability({ agentKey: 'pi' as AgentKey, models: [{ modelId: 'runtime::fast' as never, displayName: 'Fast', source: 'configured' }, { modelId: 'runtime::auto' as never, displayName: 'Auto', source: 'detected' }] }),
    ]),
  ])
  t.after(() => repository.close())
  const provider = providerRevision()
  service.createResource(provider.resource); service.createRevision(provider.revision)
  service.createBinding({ id: 'provider-binding', workerId: onlineId, resourceRevisionId: provider.revision.id, agentKey: 'pi' as AgentKey, createdBy: actor })

  const snapshot = await inventory.inventory()
  const ids = snapshot.models.map(entry => entry.modelId)
  assert.ok(ids.includes('runtime::fast' as never))
  assert.ok(ids.includes('openai-compatible::cluster-model' as never))

  const declared = snapshot.models.find(entry => entry.modelId === 'openai-compatible::cluster-model')!
  assert.equal(declared.configuration.state, 'configured')
  assert.equal(declared.configuration.detail, '集群 Provider 声明')
  assert.equal(declared.distribution.state, 'pending')
  assert.equal(declared.execution.state, 'unknown')

  const runtimeModel = snapshot.models.find(entry => entry.modelId === 'runtime::fast')!
  assert.equal(runtimeModel.configuration.state, 'configured')
  assert.equal(runtimeModel.execution.state, 'executable')
  assert.equal(runtimeModel.authentication.state, 'unknown')
})

test('Provider 认证与分发只取自 Worker 回执，凭据取值不出现在管理面', async t => {
  const { repository, service, inventory } = await harness([workerRecord(onlineId, 'online', [])])
  t.after(() => repository.close())
  const provider = providerRevision()
  service.createResource(provider.resource); service.createRevision(provider.revision)
  const binding = service.createBinding({ id: 'provider-binding', workerId: onlineId, resourceRevisionId: provider.revision.id, agentKey: 'pi' as AgentKey, createdBy: actor })
  const set = service.desiredSet(onlineId)

  const before = (await inventory.inventory()).providers[0]!
  assert.equal(before.authentication.state, 'unknown')
  assert.equal(before.distribution.state, 'pending')
  assert.equal(before.distribution.detail, '尚未收到 Worker 安装回执')
  assert.equal(before.distribution.observedAt, null)
  assert.equal(before.execution.state, 'not-applicable')
  // 管理面只展示凭据定位（变量名），永远看不到取值。
  assert.match(before.configuration.detail, /环境变量 OPENAI_API_KEY/)

  const report = (overrides: Partial<ReconcileReport>): ReconcileReport => ({
    requestId: `request-${Math.random()}`, workerId: onlineId, resourceSetRevision: set.revision, bindingId: binding.id, bindingRevision: binding.revision,
    resourceRevisionId: provider.revision.id, resourceId: provider.resource.id, kind: 'model-provider', integrity: provider.revision.contentSha256,
    result: 'installed', phase: 'credential-required', progressBytes: null, errorCode: null, message: null, activeRevision: 1, previousRevision: null, occurredAt: at, ...overrides,
  })
  service.reconcile(report({ errorCode: 'credential_required', message: '需要在 Worker 本地配置模型凭据' }))
  const missing = (await inventory.inventory()).providers[0]!
  assert.equal(missing.authentication.state, 'unauthenticated')
  assert.equal(missing.distribution.state, 'pending')
  assert.equal(missing.authentication.observedAt, at)
  assert.equal(missing.authentication.detail, '需要在 Worker 本地配置模型凭据')

  service.reconcile(report({ message: '本地模型凭据已配置；尚未验证模型探测或 Agent 注入' }))
  const configured = (await inventory.inventory()).providers[0]!
  assert.equal(configured.authentication.state, 'authenticated')
  assert.equal(configured.authentication.detail, '本地模型凭据已配置；尚未验证模型探测或 Agent 注入')
  const published = JSON.stringify(await inventory.inventory())
  assert.doesNotMatch(published, /sk-[A-Za-z0-9]/, '管理面不得出现凭据取值')
  assert.doesNotMatch(published, /password|token=/i)
})

test('分发状态区分已确认、等待重启与安装失败，并保留回执时间', async t => {
  const content = Buffer.from('SKILL')
  const { repository, service, inventory } = await harness([workerRecord(onlineId, 'online', [capability({ agentKey: 'pi' as AgentKey })])])
  t.after(() => repository.close())
  const skill = skillRevision(content, sha('SKILL'))
  const second: ResourceRevision = { ...skill.revision, id: 'skill-rev-2', version: 2, manifest: { ...skill.revision.manifest, sha256: sha('SKILL2') }, contentSha256: sha('SKILL2'), payload: { mode: 'blobs', files: [{ path: 'SKILL.md', size: content.length, mediaType: 'text/markdown', sha256: sha('SKILL2'), blobSha256: sha('SKILL2') }] }, supplyChain: { mode: 'static-content', manifestSha256: sha('SKILL2') } }
  service.createResource(skill.resource); service.createRevision(skill.revision); service.createRevision(second)
  const ok = service.createBinding({ id: 'skill-binding-ok', workerId: onlineId, resourceRevisionId: skill.revision.id, createdBy: actor })
  const slow = service.createBinding({ id: 'skill-binding-waiting', workerId: onlineId, resourceRevisionId: second.id, createdBy: actor })
  assert.equal(slow.status, 'notified')

  const set = service.desiredSet(onlineId)
  service.reconcile({ requestId: 'r-1', workerId: onlineId, resourceSetRevision: set.revision, bindingId: ok.id, bindingRevision: ok.revision, resourceRevisionId: skill.revision.id, resourceId: skill.resource.id, kind: 'skill', integrity: skill.revision.contentSha256, result: 'installed', phase: 'ready', progressBytes: null, errorCode: null, message: null, activeRevision: 1, previousRevision: null, occurredAt: at })
  const snapshot = await inventory.inventory()
  const entry = snapshot.skills.find(item => item.id === skill.resource.id)!
  assert.equal(entry.authentication.state, 'not-required')
  assert.equal(entry.distribution.state, 'pending', '仍有未完成目标的技能不算全部分发')
  const target = entry.targets.find(item => item.workerId === onlineId)!
  assert.equal(target.distribution.observedAt, at)
  assert.equal(target.distribution.setRevision, set.revision)
})

test('预设列出为模板，不直接声明可执行', async t => {
  const content = Buffer.from('SKILL')
  const { repository, service, inventory } = await harness([workerRecord(onlineId, 'online', [])])
  t.after(() => repository.close())
  const skill = skillRevision(content, sha('SKILL'))
  service.createResource(skill.resource); service.createRevision(skill.revision)
  service.createPreset({ name: '评审套件', description: '技能与运行时', expectedRevision: 0, entries: [{ resourceId: skill.resource.id, resourceRevisionId: skill.revision.id, agentKey: null, projectId: null, required: true }], createdBy: actor })

  const snapshot = await inventory.inventory()
  const preset = snapshot.presets[0]!
  assert.equal(preset.name, '评审套件')
  assert.equal(preset.configuration.state, 'configured')
  assert.equal(preset.authentication.state, 'not-required')
  assert.equal(preset.execution.state, 'not-applicable')
  assert.equal(preset.distribution.state, 'not-distributed')
})
