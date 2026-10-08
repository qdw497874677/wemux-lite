import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentKey, ModelId, UserId } from '@wemux/domain'
import type { HttpConnectorDefinition } from '@wemux/connector'
import { CapabilityService } from '../application/capability-service.js'
import { CapabilityTokenService } from '../application/capability-token-service.js'
import { ServerService, now } from '../application/server-service.js'
import { Notifications } from '../application/notifications.js'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { seedOperator } from './fixtures/administrator.js'

const timestamp = '2026-01-01T00:00:00.000Z' as never

function connector(projectId: string, overrides: Partial<HttpConnectorDefinition> = {}): HttpConnectorDefinition {
  return { id: 'connector-visible' as never, projectId: projectId as never, kind: 'http', name: 'Fixture HTTP', description: null, revision: 1, enabled: true, allowedWorkerIds: [], credentialRef: null, credentialAvailability: 'not_required', riskDefaults: { requireApprovalForRead: false, allowMcpReadOnlyHint: false }, config: { baseUrl: 'https://fixture.example.test', authentication: 'none', publicHeaders: {}, allowedOperations: [{ id: 'create', description: 'Create item', method: 'POST', pathTemplate: '/items', allowedQueryNames: [], allowedRequestHeaderNames: [], requestContentTypes: ['application/json'], operationTypeOverride: null }], allowPrivateNetwork: false }, createdAt: timestamp, updatedAt: timestamp, ...overrides }
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-capability-connectors-'))
  const store = new SqliteServerStore(join(directory, 'server.sqlite'))
  t.after(() => { store.close(); return rm(directory, { recursive: true, force: true }) })
  const baseCapabilities = new CapabilityService(store, now, new CapabilityTokenService('seed-secret'.repeat(4), now))
  const service = new ServerService(store, new Notifications(), baseCapabilities)
  const { project, user } = await seedOperator(store, service)
  const enrolled = await service.enroll({ token: (await service.createEnrollment({})).token, name: 'worker' })
  await store.transaction(tx => tx.resources.saveWorker({ ...enrolled.worker, capabilities: [{ agentKey: 'pi' as AgentKey, displayName: 'Pi', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'test' as ModelId, displayName: 'Test', source: 'detected' }] }] }))
  const { workspace } = await service.createWorkspace({ projectId: project!.id, workerId: enrolled.workerId, name: 'workspace', repository: { gitUrl: 'https://example.test/repository.git' } })
  await store.transaction(tx => tx.resources.saveWorkspace({ ...workspace, status: 'ready' }))
  const { session } = await service.createSession({ requestId: 'capability-session', workspaceId: workspace.id, title: 'session', agentKey: 'pi', modelId: 'test' })
  return { store, project: project!, user: user!, workerId: enrolled.workerId, session }
}

test('capability grant resolves enabled Project connectors visible to the actor and Worker', async t => {
  const f = await fixture(t)
  const visible = connector(f.project.id)
  const disabled = connector(f.project.id, { id: 'connector-disabled' as never, enabled: false })
  const wrongWorker = connector(f.project.id, { id: 'connector-wrong-worker' as never, allowedWorkerIds: ['worker-other' as never] })
  const tokens = new CapabilityTokenService('test-secret'.repeat(4), () => timestamp)
  const capabilities = new CapabilityService(f.store, () => timestamp, tokens, { list: async () => [visible, disabled, wrongWorker] })
  const context = await capabilities.prepareTurn({ sessionId: f.session.id, turnId: 'turn-visible' as never, actorId: f.user.id })
  assert.deepEqual(context.runtime.snapshot.allowedConnectorIds, [visible.id])
  assert.deepEqual(context.runtime.snapshot.connectors, [visible])
  assert.deepEqual(context.runtime.grant.allowedConnectorIds, [visible.id])
  assert.deepEqual(tokens.verify(context.token).allowedConnectorIds, [visible.id])
  assert.equal(context.runtime.snapshot.allowedTools.includes('http.call'), true)
})

test('session enqueue resolves connectors through transaction readers', async t => {
  const f = await fixture(t)
  const visible = connector(f.project.id, { allowedWorkerIds: [f.workerId] })
  const capabilities = new CapabilityService(f.store, () => timestamp, new CapabilityTokenService('transaction-secret'.repeat(4), () => timestamp), { list: async () => [visible] })
  const service = new ServerService(f.store, new Notifications(), capabilities)
  const result = await service.enqueue(f.session.id, { content: '使用连接器' }, f.user.id)
  const pending = await f.store.commands.getPendingCommand(result.commandId)
  assert.equal(pending?.command.kind, 'session.enqueue')
  if (pending?.command.kind !== 'session.enqueue') return
  assert.deepEqual(pending.command.capabilities?.snapshot.allowedConnectorIds, [visible.id])
  assert.deepEqual(pending.command.capabilities?.snapshot.connectors, [visible])
  assert.deepEqual(pending.command.capabilities?.grant.allowedConnectorIds, [visible.id])
})

test('capability snapshot injects a versioned same-Worker collaboration roster and canonical session protocol', async t => {
  const f = await fixture(t)
  const capabilities = new CapabilityService(f.store, () => timestamp, new CapabilityTokenService('collaboration-secret'.repeat(4), () => timestamp))
  const first = await capabilities.prepareTurn({ sessionId: f.session.id, turnId: 'turn-roster-1' as never, actorId: f.user.id })
  assert.equal(first.runtime.snapshot.collaboration?.canonicalSessionId, f.session.id)
  assert.equal(first.runtime.snapshot.collaboration?.roster.some(item => item.sessionId === f.session.id && item.workerId === f.workerId), true)
  assert.match(first.runtime.snapshot.collaboration?.instructions ?? '', /delegation_request/)
  assert.match(first.runtime.snapshot.collaboration?.instructions ?? '', /\[SILENT\]/)
  const originalVersion = first.runtime.snapshot.collaboration?.version
  const { session: secondSession } = await new ServerService(f.store, new Notifications(), capabilities).createSession({ requestId: 'capability-session-two', workspaceId: f.session.workspaceId, title: 'second', agentKey: 'pi', modelId: 'test' })
  const second = await capabilities.prepareTurn({ sessionId: f.session.id, turnId: 'turn-roster-2' as never, actorId: f.user.id })
  assert.equal(second.runtime.snapshot.collaboration?.roster.some(item => item.sessionId === secondSession.id), true)
  assert.notEqual(second.runtime.snapshot.collaboration?.version, originalVersion)
})

test('capability connector resolution fails closed for missing actor, A3-invisible actor, and repository failure', async t => {
  const f = await fixture(t)
  const visible = connector(f.project.id)
  const tokens = new CapabilityTokenService('test-secret'.repeat(4), () => timestamp)
  const noActor = new CapabilityService(f.store, () => timestamp, tokens, { list: async () => [visible] })
  assert.deepEqual((await noActor.prepareTurn({ sessionId: f.session.id, turnId: 'turn-no-actor' as never })).runtime.snapshot.allowedConnectorIds, [])
  const failed = new CapabilityService(f.store, () => timestamp, tokens, { list: async () => { throw new Error('repository unavailable') } })
  assert.deepEqual((await failed.prepareTurn({ sessionId: f.session.id, turnId: 'turn-failed' as never, actorId: f.user.id })).runtime.snapshot.allowedConnectorIds, [])
  const viewer = 'viewer-user' as UserId
  await f.store.transaction(tx => tx.identity.saveUser({ id: viewer, email: 'viewer@example.com', username: 'viewer', createdAt: timestamp, status: 'active', authVersion: 0, statusChangedAt: timestamp, deletedAt: null }))
  const viewerCapabilities = new CapabilityService(f.store, () => timestamp, tokens, { list: async () => [visible] })
  assert.deepEqual((await viewerCapabilities.prepareTurn({ sessionId: f.session.id, turnId: 'turn-viewer' as never, actorId: viewer })).runtime.snapshot.allowedConnectorIds, [])
})
