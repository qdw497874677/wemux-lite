import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AesGcmSecretCodec, stableFingerprint } from '@wemux/connector'
import { ChannelService } from '../application/channel-service.js'
import { ChannelRouter } from '../application/channel-router.js'
import { ChannelOutbox } from '../application/channel-outbox.js'
import { GenericWebhookAdapter } from '../channels/generic-webhook-adapter.js'
import { SqliteChannelRepository } from '../storage/sqlite/channel-repository.js'

const actor = 'user-1' as never, projectId = 'project-1' as never, sessionId = 'session-1' as never, workerId = 'worker-1' as never
const session = { id: sessionId, projectId, ownerId: actor, deletedAt: null, binding: { agent: { workerId } } }
const projects = { require: async () => ({ id: projectId, ownerId: actor, accessRole: 'owner' }) }
const sessions = { require: async () => session }
const workers = { require: async () => ({ id: workerId, ownerId: actor, accessRole: 'owner' }) }

async function fixture(callbackUrl = 'https://receiver.example/webhook') {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-channel-'))
  const path = join(dir, 'server.sqlite'), repository = new SqliteChannelRepository(path), codec = new AesGcmSecretCodec({ currentKey: 'channel-test-key' })
  const service = new ChannelService(repository, codec, projects as never, sessions as never, workers as never)
  const createValue = { operation: 'create', name: 'Fixture', callbackUrl: null, sourceCidrs: [] }
  const created = await service.create(actor, { projectId, requestId: 'create-1', fingerprint: stableFingerprint(createValue), kind: 'generic_webhook', name: 'Fixture', callbackUrl: null, sourceCidrs: [] })
  const bindingValue = { operation: 'binding.create', channelId: created.channel.id, externalConversationKey: 'conversation-1', sessionId, callbackUrl, senderAllowlist: [] }
  const binding = await service.createBinding(actor, { projectId, requestId: 'binding-1', fingerprint: stableFingerprint(bindingValue), channelId: created.channel.id, externalConversationKey: 'conversation-1', sessionId, callbackUrl, senderAllowlist: [] })
  return { dir, path, repository, codec, service, created, binding, close: async () => { repository.close(); await rm(dir, { recursive: true, force: true }) } }
}

const body = Buffer.from(JSON.stringify({ conversation: 'conversation-1', sender: 'caller-1', text: 'hello' }))

test('generic webhook persists before ACK and duplicate delivery enqueues only once across restart', async () => {
  const f = await fixture(); try {
    const adapter = new GenericWebhookAdapter(f.repository, f.codec)
    const request = { channelId: f.created.channel.id, authorization: `Bearer ${f.created.issuedToken}`, deliveryId: 'delivery-1', timestamp: new Date().toISOString(), body }
    assert.equal((await adapter.accept(request)).kind, 'accepted')
    assert.equal((await adapter.accept(request)).kind, 'duplicate')
    let enqueued = 0
    const router = new ChannelRouter(f.repository, sessions as never, projects as never, workers as never, { enqueue: async () => { enqueued++ } } as never)
    assert.equal(await router.drain(), 1); assert.equal(await router.drain(), 0); assert.equal(enqueued, 1)
    f.repository.close()
    const reopened = new SqliteChannelRepository(f.path)
    const restarted = new GenericWebhookAdapter(reopened, f.codec)
    assert.equal((await restarted.accept(request)).kind, 'duplicate')
    assert.equal((await reopened.listInbound(projectId, 10))[0]?.status, 'enqueued')
    reopened.close()
  } finally { await rm(f.dir, { recursive: true, force: true }) }
})

test('Channel delivery issues commands as the binding creator, never the private Session owner', async () => {
  const f = await fixture(); try {
    const project = { ...session, ownerId: 'session-owner' }
    const adapter = new GenericWebhookAdapter(f.repository, f.codec)
    const request = { channelId: f.created.channel.id, authorization: `Bearer ${f.created.issuedToken}`, deliveryId: 'as-creator', timestamp: new Date().toISOString(), body }
    assert.equal((await adapter.accept(request)).kind, 'accepted')
    const observed: unknown[] = []
    const router = new ChannelRouter(f.repository, { require: async () => project } as never, projects as never, workers as never,
      { enqueue: async (_session: unknown, _message: unknown, actorId: unknown) => { observed.push(actorId) } } as never)
    assert.equal(await router.drain(), 1)
    assert.deepEqual(observed, [actor], 'the persisted binding creator, not the private Session owner, must authorize enqueue')
    assert.notEqual(observed[0], project.ownerId)
  } finally { await f.close() }
})

test('delivery identity conflict is rejected and disabled channel fails closed', async () => {
  const f = await fixture(); try {
    const adapter = new GenericWebhookAdapter(f.repository, f.codec), timestamp = new Date().toISOString()
    await adapter.accept({ channelId: f.created.channel.id, authorization: `Bearer ${f.created.issuedToken}`, deliveryId: 'same-id', timestamp, body })
    await assert.rejects(() => adapter.accept({ channelId: f.created.channel.id, authorization: `Bearer ${f.created.issuedToken}`, deliveryId: 'same-id', timestamp, body: Buffer.from(JSON.stringify({ conversation: 'conversation-1', sender: 'caller-1', text: 'changed' })) }), /fingerprint conflict/)
    const value = { operation: 'disable', channelId: f.created.channel.id, expectedRevision: 1 }
    await f.service.setEnabled(actor, { projectId, channelId: f.created.channel.id, expectedRevision: 1, enabled: false, requestId: 'disable-1', fingerprint: stableFingerprint(value) })
    await assert.rejects(() => adapter.accept({ channelId: f.created.channel.id, authorization: `Bearer ${f.created.issuedToken}`, deliveryId: 'later', timestamp, body }), /disabled/)
  } finally { await f.close() }
})

test('token rotation accepts both revisions for 15 minutes and then rejects the old token', async () => {
  const f = await fixture(); try {
    const adapter = new GenericWebhookAdapter(f.repository, f.codec)
    const value = { operation: 'rotate_token', channelId: f.created.channel.id, expectedRevision: 1 }
    const rotated = await f.service.rotateToken(actor, { projectId, channelId: f.created.channel.id, expectedRevision: 1, requestId: 'rotate-1', fingerprint: stableFingerprint(value) })
    assert.ok(rotated.issuedToken); assert.equal(rotated.channel.revision, 2)
    const within = new Date(Date.parse(rotated.channel.updatedAt) + 14 * 60_000)
    assert.equal((await adapter.accept({ channelId: f.created.channel.id, authorization: `Bearer ${f.created.issuedToken}`, deliveryId: 'old-within', timestamp: within.toISOString(), body, receivedAt: within })).kind, 'accepted')
    assert.equal((await adapter.accept({ channelId: f.created.channel.id, authorization: `Bearer ${rotated.issuedToken}`, deliveryId: 'new-now', timestamp: within.toISOString(), body, receivedAt: within })).kind, 'accepted')
    const expired = new Date(Date.parse(rotated.channel.updatedAt) + 16 * 60_000)
    await assert.rejects(() => adapter.accept({ channelId: f.created.channel.id, authorization: `Bearer ${f.created.issuedToken}`, deliveryId: 'old-expired', timestamp: expired.toISOString(), body, receivedAt: expired }), /Invalid Channel token/)
    assert.equal((await adapter.accept({ channelId: f.created.channel.id, authorization: `Bearer ${rotated.issuedToken}`, deliveryId: 'new-later', timestamp: expired.toISOString(), body, receivedAt: expired })).kind, 'accepted')
  } finally { await f.close() }
})

test('token rotation is idempotent and rejects stale CAS revision', async () => {
  const f = await fixture(); try {
    const value = { operation: 'rotate_token', channelId: f.created.channel.id, expectedRevision: 1 }
    const first = await f.service.rotateToken(actor, { projectId, channelId: f.created.channel.id, expectedRevision: 1, requestId: 'rotate-idem', fingerprint: stableFingerprint(value) })
    const replay = await f.service.rotateToken(actor, { projectId, channelId: f.created.channel.id, expectedRevision: 1, requestId: 'rotate-idem', fingerprint: stableFingerprint(value) })
    assert.equal(replay.replayed, true); assert.equal(replay.channel.revision, first.channel.revision); assert.equal(replay.issuedToken, undefined)
    const stale = { operation: 'rotate_token', channelId: f.created.channel.id, expectedRevision: 1 }
    await assert.rejects(() => f.service.rotateToken(actor, { projectId, channelId: f.created.channel.id, expectedRevision: 1, requestId: 'rotate-stale', fingerprint: stableFingerprint(stale) }), /revision conflict/)
    assert.equal((await f.repository.getSecrets(f.created.channel.id, new Date().toISOString() as never)).length, 2)
  } finally { await f.close() }
})

test('Channel deletion requires disable, removes definition and credentials, and preserves diagnostics', async () => {
  const f = await fixture(); try {
    const adapter = new GenericWebhookAdapter(f.repository, f.codec)
    await adapter.accept({ channelId: f.created.channel.id, authorization: `Bearer ${f.created.issuedToken}`, deliveryId: 'before-delete', timestamp: new Date().toISOString(), body })
    const early = { operation: 'delete', channelId: f.created.channel.id, expectedRevision: 1 }
    await assert.rejects(() => f.service.delete(actor, { projectId, channelId: f.created.channel.id, expectedRevision: 1, requestId: 'delete-early', fingerprint: stableFingerprint(early) }), /must be disabled/)
    const disable = { operation: 'disable', channelId: f.created.channel.id, expectedRevision: 1 }
    const disabled = await f.service.setEnabled(actor, { projectId, channelId: f.created.channel.id, expectedRevision: 1, enabled: false, requestId: 'disable-delete', fingerprint: stableFingerprint(disable) })
    const deletion = { operation: 'delete', channelId: f.created.channel.id, expectedRevision: disabled.channel.revision }
    const deleted = await f.service.delete(actor, { projectId, channelId: f.created.channel.id, expectedRevision: disabled.channel.revision, requestId: 'delete-ok', fingerprint: stableFingerprint(deletion) })
    assert.equal(deleted.replayed, false); assert.equal(await f.repository.getChannel(f.created.channel.id), null); assert.equal(await f.repository.getSecret(f.created.channel.id), null)
    const diagnostic = (await f.repository.listInbound(projectId, 10))[0]!
    assert.equal(diagnostic.channelDeleted, true); assert.match(diagnostic.diagnostic ?? '', /Channel 已删除/)
    await assert.rejects(() => adapter.accept({ channelId: f.created.channel.id, authorization: `Bearer ${f.created.issuedToken}`, deliveryId: 'after-delete', timestamp: new Date().toISOString(), body }), /Channel not found/)
    const replay = await f.service.delete(actor, { projectId, channelId: f.created.channel.id, expectedRevision: disabled.channel.revision, requestId: 'delete-ok', fingerprint: stableFingerprint(deletion) })
    assert.equal(replay.replayed, true)
  } finally { await f.close() }
})

test('Channel deletion waits for an active sending lease', async () => {
  const f = await fixture(); try {
    const at = new Date(), leaseUntil = new Date(at.getTime() + 60_000).toISOString() as never
    await f.repository.saveOutbound({ id: 'leased-delivery', channelId: f.created.channel.id, bindingId: f.binding.binding.id, projectId, sessionId, journalEventIdentity: 'leased-event', callbackUrl: f.binding.callbackUrl, content: 'reply', status: 'sending', attempt: 1, nextAttemptAt: null, leaseExpiresAt: leaseUntil, responseStatus: null, diagnostic: null, createdAt: at.toISOString() as never, updatedAt: at.toISOString() as never, deliveredAt: null })
    const disable = { operation: 'disable', channelId: f.created.channel.id, expectedRevision: 1 }
    const disabled = await f.service.setEnabled(actor, { projectId, channelId: f.created.channel.id, expectedRevision: 1, enabled: false, requestId: 'disable-lease', fingerprint: stableFingerprint(disable) })
    const deletion = { operation: 'delete', channelId: f.created.channel.id, expectedRevision: disabled.channel.revision }
    await assert.rejects(() => f.service.delete(actor, { projectId, channelId: f.created.channel.id, expectedRevision: disabled.channel.revision, requestId: 'delete-leased', fingerprint: stableFingerprint(deletion) }), /active sending lease/)
  } finally { await f.close() }
})

test('Channel deletion rejects stale CAS revision', async () => {
  const f = await fixture(); try {
    const disable = { operation: 'disable', channelId: f.created.channel.id, expectedRevision: 1 }
    await f.service.setEnabled(actor, { projectId, channelId: f.created.channel.id, expectedRevision: 1, enabled: false, requestId: 'disable-cas', fingerprint: stableFingerprint(disable) })
    const deletion = { operation: 'delete', channelId: f.created.channel.id, expectedRevision: 1 }
    await assert.rejects(() => f.service.delete(actor, { projectId, channelId: f.created.channel.id, expectedRevision: 1, requestId: 'delete-stale', fingerprint: stableFingerprint(deletion) }), /revision conflict/)
  } finally { await f.close() }
})

test('router fails closed after binding authorization is revoked', async () => {
  const f = await fixture(); try {
    const adapter = new GenericWebhookAdapter(f.repository, f.codec)
    await adapter.accept({ channelId: f.created.channel.id, authorization: `Bearer ${f.created.issuedToken}`, deliveryId: 'revoked-1', timestamp: new Date().toISOString(), body })
    const revokedProjects = { require: async () => { throw new Error('Project manager grant revoked') } }
    const router = new ChannelRouter(f.repository, sessions as never, revokedProjects as never, workers as never, { enqueue: async () => assert.fail('must not enqueue') } as never)
    await router.drain()
    const inbound = (await f.repository.listInbound(projectId, 10))[0]!
    assert.equal(inbound.status, 'failed_closed'); assert.match(inbound.diagnostic ?? '', /revoked/)
  } finally { await f.close() }
})

test('outbox aggregates assistant deltas, retries six times, dead-letters, and can be replayed', async () => {
  let requests = 0
  const retryingFetch = async () => { requests++; return new Response('retry', { status: 503 }) }
  const f = await fixture('https://receiver.example/callback')
  try {
    const occurredAt = '2026-01-01T00:00:00.000Z' as never
    const events = [
      { sessionId, seq: 1 as never, occurredAt, payload: { kind: 'assistant.text.delta', turnId: 'turn-1' as never, text: 'hello ' } },
      { sessionId, seq: 2 as never, occurredAt, payload: { kind: 'assistant.text.delta', turnId: 'turn-1' as never, text: 'world' } },
      { sessionId, seq: 3 as never, occurredAt, payload: { kind: 'turn.finished', turnId: 'turn-1' as never, outcome: 'completed', failure: null } },
    ] as const
    const store = { resources: { getSession: async () => session }, cache: { readEvents: async (_id: unknown, from: number) => ({ events: events.filter(event => event.seq >= from), nextSeq: null }) } }
    const outbox = new ChannelOutbox(f.repository, projects as never, sessions as never, workers as never, store as never, {}, retryingFetch as typeof fetch)
    assert.equal(await outbox.projectJournal(sessionId, events as never), 1)
    assert.equal(await outbox.projectJournal(sessionId, events as never), 0)
    for (let attempt = 0; attempt < 6; attempt++) await outbox.drain(20, new Date(2_000_000_000_000 + attempt * 100_000))
    const delivery = (await f.repository.listOutbound(projectId, 10))[0]!
    assert.equal(requests, 6); assert.equal(delivery.status, 'dead_letter'); assert.equal(delivery.attempt, 6); assert.equal(delivery.content, 'hello world')
    const replayValue = { operation: 'outbound.replay', deliveryId: delivery.id, reason: 'operator retry' }
    const replayed = await f.service.replay(actor, projectId, delivery.id, 'operator retry', { projectId, requestId: 'replay-1', fingerprint: stableFingerprint(replayValue) })
    assert.equal(replayed.status, 'pending')
  } finally { await f.close() }
})

test('scoped delivery detail finds records older than the latest 100 and preserves deleted-channel diagnostics', async () => {
  const f = await fixture()
  try {
    for (let i = 0; i <= 100; i++) {
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() as never
      await f.repository.saveOutbound({ id: `detail-${i}`, channelId: f.created.channel.id, bindingId: f.binding.binding.id, projectId, sessionId, journalEventIdentity: `detail-event-${i}`, callbackUrl: f.binding.callbackUrl, content: `reply-${i}`, status: i === 0 ? 'dead_letter' : 'delivered', attempt: 6, nextAttemptAt: null, leaseExpiresAt: null, responseStatus: 503, diagnostic: 'old failure', createdAt: at, updatedAt: at, deliveredAt: null })
    }
    const list = await f.service.deliveries(actor, projectId)
    assert.equal(list.outbound.length, 100)
    assert.equal(list.outbound.some(item => item.id === 'detail-0'), false)
    const { DatabaseSync } = await import('node:sqlite')
    const inspection = new DatabaseSync(f.path, { readOnly: true })
    try {
      const plan = inspection.prepare('EXPLAIN QUERY PLAN SELECT d.data,c.id AS live_channel FROM channel_outbound_deliveries d LEFT JOIN channel_definitions c ON c.id=d.channel_id AND c.project_id=d.project_id WHERE d.id=? AND d.project_id=?').all('detail-0', projectId)
      assert.ok(plan.some(row => /SEARCH d USING INDEX .*\(id=\?\)/.test(String(row.detail))), JSON.stringify(plan))
      assert.ok(!plan.some(row => /SCAN d\b/.test(String(row.detail))), JSON.stringify(plan))
    } finally { inspection.close() }
    const detail = await f.service.delivery(actor, projectId, 'detail-0')
    assert.equal(detail.id, 'detail-0')
    assert.equal(detail.status, 'dead_letter')
    assert.equal(detail.diagnostic, 'old failure')
    assert.equal(await f.repository.getProjectOutbound('other-project' as never, detail.id), null)
    await assert.rejects(() => f.service.delivery(actor, 'other-project' as never, detail.id), { status: 404, code: 'delivery_not_found' })
    await assert.rejects(() => f.service.delivery(actor, projectId, 'missing'), { status: 404, code: 'delivery_not_found' })
    const disable = { operation: 'disable', channelId: f.created.channel.id, expectedRevision: 1 }
    await f.service.setEnabled(actor, { projectId, channelId: f.created.channel.id, expectedRevision: 1, enabled: false, requestId: 'detail-disable', fingerprint: stableFingerprint(disable) })
    const deletion = { operation: 'delete', channelId: f.created.channel.id, expectedRevision: 2 }
    await f.service.delete(actor, { projectId, channelId: f.created.channel.id, expectedRevision: 2, requestId: 'detail-delete', fingerprint: stableFingerprint(deletion) })
    const deleted = await f.service.delivery(actor, projectId, detail.id)
    assert.equal(deleted.channelDeleted, true)
    assert.match(deleted.diagnostic!, /old failure；Channel 已删除/)
  } finally { await f.close() }
})

test('delivery detail requires manager before lookup and replay preserves Session control and Worker use', async () => {
  const { AppError } = await import('../application/errors.js')
  const f = await fixture()
  try {
    const calls: string[] = []
    let denied: 'project' | 'session' | 'worker' | null = null
    const access = { require: async (_user: unknown, _project: unknown, role: string) => {
      calls.push(`project:${role}`)
      if (denied === 'project') throw new AppError(404, 'Project not found')
      return { accessRole: 'manager' }
    } }
    const sessionAccess = { require: async (_user: unknown, _session: unknown, capability: string) => {
      calls.push(`session:${capability}`)
      if (denied === 'session') throw new AppError(404, 'Session not found')
      return session
    } }
    const workerAccess = { require: async (_user: unknown, _worker: unknown, capability: string) => {
      calls.push(`worker:${capability}`)
      if (denied === 'worker') throw new AppError(404, 'Worker not found')
    } }
    let reads = 0
    const original = f.repository.getProjectOutbound.bind(f.repository)
    f.repository.getProjectOutbound = async (...args) => { reads++; return original(...args) }
    const service = new ChannelService(f.repository, f.codec, access as never, sessionAccess as never, workerAccess as never)
    const at = new Date().toISOString() as never
    await f.repository.saveOutbound({ id: 'authorized-detail', channelId: f.created.channel.id, bindingId: f.binding.binding.id, projectId, sessionId, journalEventIdentity: 'authorized-detail-event', callbackUrl: f.binding.callbackUrl, content: 'reply', status: 'dead_letter', attempt: 6, nextAttemptAt: null, leaseExpiresAt: null, responseStatus: 503, diagnostic: 'failed', createdAt: at, updatedAt: at, deliveredAt: null })
    denied = 'project'
    await assert.rejects(() => service.delivery(actor, projectId, 'authorized-detail'), { status: 404 })
    assert.equal(reads, 0)
    assert.deepEqual(calls.splice(0), ['project:manager'])
    denied = 'session'
    await assert.rejects(() => service.delivery(actor, projectId, 'authorized-detail'), { status: 404, code: 'delivery_not_found' })
    assert.deepEqual(calls.splice(0), ['project:manager', 'session:read'])
    denied = null
    assert.equal((await service.delivery(actor, projectId, 'authorized-detail')).id, 'authorized-detail')
    assert.deepEqual(calls.splice(0), ['project:manager', 'session:read'])
    const value = { operation: 'outbound.replay', deliveryId: 'authorized-detail', reason: 'retry' }
    const replay = () => service.replay(actor, projectId, value.deliveryId, value.reason, { projectId, requestId: 'replay-access', fingerprint: stableFingerprint(value) })
    for (const layer of ['project', 'session', 'worker'] as const) {
      denied = layer
      await assert.rejects(replay, { status: 404 })
      assert.deepEqual(calls.splice(0), ['project:manager', 'session:control', 'worker:use'].slice(0, ['project', 'session', 'worker'].indexOf(layer) + 1))
      assert.equal((await f.repository.getOutbound(value.deliveryId))!.status, 'dead_letter')
    }
    denied = null
    assert.equal((await replay()).status, 'pending')
    assert.deepEqual(calls.splice(0), ['project:manager', 'session:control', 'worker:use'])
    denied = 'session'
    await assert.rejects(replay, { status: 404 }, 'idempotent replay must reauthorize')
  } finally { await f.close() }
})

test('HTTP Channel privacy filters whole Session records for viewers, managers, revocation and deleted Channels', async () => {
  const { createWemuxServer } = await import('../server.ts')
  const { hashSecret } = await import('../application/auth.ts')
  const { administratorEmail, seedAdministrator } = await import('./fixtures/administrator.ts')
  const callbackSecret = 'PRIVATE_BINDING_CREDENTIAL_SENTINEL'
  const f = await fixture(`https://receiver.example/?token=${callbackSecret}`)
  const app = createWemuxServer({ databasePath: f.path, administratorEmails: [administratorEmail], mail: {}, google: {}, channelEncryptionKey: 'channel-test-key' })
  try {
    const admin = await seedAdministrator(app.store)
    const { project } = await app.service.ensureDefaultEnvironment(admin.userId)
    const at = new Date().toISOString() as never
    const publicSessionId = 'public-session' as never
    const users = ['viewer', 'manager', 'granted-manager'] as const
    await app.store.transaction(async tx => {
      await tx.resources.saveProject({ ...project, id: projectId, shareScope: 'selected-members' })
      for (const name of users) {
        const userId = name as never
        await tx.identity.saveUser({ id: userId, username: name, email: `${name}@example.test`, status: 'active', createdAt: at })
        await tx.identity.saveMembership({ userId, teamId: project.teamId, role: 'member', joinedAt: at })
        await tx.identity.saveProjectGrant({ userId, projectId, role: name === 'viewer' ? 'viewer' : 'manager' })
        await tx.identity.savePersonalAccessToken({ id: `${name}-pat` as never, userId, name: 'Privacy test', scopes: ['read', 'write'], tokenHash: hashSecret(`${name}-token`), createdAt: at, expiresAt: '2099-01-01T00:00:00Z' as never, lastUsedAt: null, revokedAt: null })
      }
      for (const id of [sessionId, publicSessionId]) await tx.resources.saveSession({ id, projectId, ownerId: admin.userId, workspaceId: 'private-workspace' as never, title: 'Session', shareScope: id === sessionId ? 'selected-members' : 'project', binding: { workspaceId: 'private-workspace' as never, agent: { workerId, agentKey: 'test' as never }, modelId: 'model' as never }, runtimeState: 'idle', deletedAt: null })
      await tx.identity.saveSessionGrant({ sessionId, userId: 'granted-manager' as never })
    })
    const publicBindingValue = { operation: 'binding.create', channelId: f.created.channel.id, externalConversationKey: 'public-conversation', sessionId: publicSessionId, callbackUrl: 'https://receiver.example/public', senderAllowlist: [] }
    const publicBinding = await f.service.createBinding(actor, { ...publicBindingValue, projectId, requestId: 'public-binding', fingerprint: stableFingerprint(publicBindingValue) })
    const contentSecret = 'PRIVATE_ASSISTANT_OUTPUT_SENTINEL', inboundSecret = 'PRIVATE_INBOUND_MESSAGE_SENTINEL', diagnosticSecret = 'PRIVATE_DIAGNOSTIC_SENTINEL'
    const outbox = new ChannelOutbox(f.repository, projects as never, sessions as never, workers as never, {
      resources: app.store.resources,
      cache: { readEvents: async () => ({ events: [{ seq: 1, payload: { kind: 'assistant.text.delta', turnId: 'privacy-turn', text: contentSecret } }], nextSeq: null }) },
    } as never)
    for (const id of [sessionId, publicSessionId]) {
      assert.equal(await outbox.projectJournal(id, [{ sessionId: id, seq: 2, occurredAt: at, payload: { kind: 'turn.finished', turnId: 'privacy-turn', outcome: 'completed', failure: null } }] as never), 1)
    }
    const generated = await f.repository.listOutbound(projectId, 10)
    const privateDelivery = generated.find(item => item.sessionId === sessionId)!
    const publicDelivery = generated.find(item => item.sessionId === publicSessionId)!
    assert.equal(privateDelivery.id, `${f.created.channel.id}:${f.binding.binding.id}:${sessionId}:2:privacy-turn`)
    for (const delivery of generated) await f.repository.updateOutbound({ ...delivery, status: 'dead_letter', nextAttemptAt: null, diagnostic: delivery.sessionId === sessionId ? diagnosticSecret : 'public failure' })
    const inbound = { id: 'private-inbound', channelId: f.created.channel.id, projectId, providerEventId: 'private-provider-event', identityStrength: 'strong' as const, fingerprint: 'private-fingerprint', tokenVersion: 1, externalConversationKey: 'conversation-1', senderId: 'caller-1', content: inboundSecret, status: 'enqueued' as const, bindingId: f.binding.binding.id, sessionId, sessionEnqueueRequestId: 'private-enqueue', diagnostic: diagnosticSecret, receivedAt: at, updatedAt: at }
    await f.repository.acceptInbound({ delivery: inbound })
    await f.repository.acceptInbound({ delivery: { ...inbound, id: 'private-pending', sessionEnqueueRequestId: 'private-pending-enqueue', providerEventId: 'private-pending', fingerprint: 'private-pending', sessionId: null, bindingId: null, status: 'routing' } })
    await f.repository.acceptInbound({ delivery: { ...inbound, id: 'private-rejected', sessionEnqueueRequestId: 'private-rejected-enqueue', providerEventId: 'private-rejected', fingerprint: 'private-rejected', sessionId: null, status: 'failed_closed' } })
    await f.repository.acceptInbound({ delivery: { ...inbound, id: 'unbound-inbound', sessionEnqueueRequestId: 'unbound-enqueue', providerEventId: 'unbound-event', fingerprint: 'unbound-fingerprint', sessionId: null, bindingId: null, externalConversationKey: 'unbound-conversation', status: 'unbound', diagnostic: 'No matching binding' } })
    const base = await app.listen(0)
    const headers = (name: string) => ({ authorization: `Bearer ${name === 'owner' ? admin.token : `${name}-token`}` })
    const detailPath = `/api/projects/${projectId}/channel-deliveries/${encodeURIComponent(privateDelivery.id)}`
    assert.equal((await fetch(`${base}${detailPath}`)).status, 401)
    for (const name of ['viewer', 'manager']) assert.equal((await fetch(`${base}/api/sessions/${sessionId}`, { headers: headers(name) })).status, 404)
    const listPath = `/api/projects/${projectId}/channels`
    for (const phase of ['live', 'revoked', 'deleted'] as const) {
      if (phase === 'revoked') await app.store.transaction(async tx => {
        await tx.identity.removeSessionGrant(sessionId, 'granted-manager' as never)
        // Session access alone still cannot expose Channel diagnostics to a Project viewer.
        await tx.identity.saveSessionGrant({ sessionId, userId: 'viewer' as never })
      })
      if (phase === 'deleted') {
        const disable = { operation: 'disable', channelId: f.created.channel.id, expectedRevision: 1 }
        await f.service.setEnabled(actor, { ...disable, projectId, enabled: false, requestId: 'privacy-disable', fingerprint: stableFingerprint(disable) })
        const deletion = { operation: 'delete', channelId: f.created.channel.id, expectedRevision: 2 }
        await f.service.delete(actor, { ...deletion, projectId, requestId: 'privacy-delete', fingerprint: stableFingerprint(deletion) })
      }
      for (const name of [...users, 'owner']) {
        const allowed = name === 'owner' || name === 'granted-manager' && phase === 'live'
        const response = await fetch(`${base}${listPath}`, { headers: headers(name) })
        assert.equal(response.status, 200)
        const text = await response.text(), list = JSON.parse(text)
        for (const secret of [contentSecret, inboundSecret, f.created.channel.credentialRef, 'credentialRef', '"config"', 'triggerPolicy']) assert.ok(!text.includes(secret), `list leaked ${secret}`)
        assert.equal(list.items.length, phase === 'deleted' ? 0 : 1)
        if (phase !== 'deleted') assert.deepEqual(Object.keys(list.items[0]).sort(), ['id', 'projectId', 'name', 'enabled', 'revision', 'credentialAvailability', 'createdAt', 'updatedAt', 'kind', 'webhookPath', 'tokenVersion', 'sourceCidrs'].sort())
        if (name === 'viewer') {
          assert.deepEqual([list.bindings, list.inbound, list.outbound], [[], [], []])
        } else {
          assert.deepEqual(list.outbound.map((item: { id: string }) => item.id).sort(), (allowed ? [privateDelivery.id, publicDelivery.id] : [publicDelivery.id]).sort())
          assert.deepEqual(list.bindings.map((item: { id: string }) => item.id).sort(), phase === 'deleted' ? [] : (allowed ? [f.binding.binding.id, publicBinding.binding.id] : [publicBinding.binding.id]).sort())
          const inboundIds = [...(phase === 'deleted' ? [] : ['unbound-inbound']), ...(allowed ? ['private-inbound', ...(phase === 'deleted' ? [] : ['private-rejected', 'private-pending'])] : [])]
          assert.deepEqual(list.inbound.map((item: { id: string }) => item.id).sort(), inboundIds.sort())
        }
        if (!allowed) for (const secret of [sessionId, f.binding.binding.id, privateDelivery.id, callbackSecret, diagnosticSecret, 'private-inbound', 'private-rejected', 'private-pending', 'conversation-1']) assert.ok(!text.includes(secret), `${phase}/${name} leaked ${secret}`)
        const detail = await fetch(`${base}${detailPath}`, { headers: headers(name) })
        assert.equal(detail.status, allowed ? 200 : 404, `${phase}/${name} detail`)
        const detailText = await detail.text()
        for (const secret of [contentSecret, callbackSecret, 'journalEventIdentity', 'callbackUrl']) assert.ok(!detailText.includes(secret))
        if (allowed) {
          const value = JSON.parse(detailText)
          assert.equal(value.id, privateDelivery.id)
          assert.equal(value.channelDeleted, phase === 'deleted' ? true : undefined)
          assert.ok(value.diagnostic.includes(diagnosticSecret))
        } else {
          assert.ok(!detailText.includes(sessionId))
          assert.ok(!detailText.includes(diagnosticSecret))
        }
        assert.equal((await fetch(`${base}/api/projects/${projectId}/channel-deliveries/missing`, { headers: headers(name) })).status, 404)
      }
      assert.equal((await fetch(`${base}${detailPath}/replay`, { method: 'POST', headers: { ...headers('viewer'), 'content-type': 'application/json' }, body: JSON.stringify({ requestId: `viewer-replay-${phase}`, reason: 'retry' }) })).status, 404)
    }
    // Deep links use the same authorization even after a record leaves the latest-100 list.
    for (let i = 0; i < 101; i++) {
      const later = new Date(Date.parse(at) + 1000 + i).toISOString() as never
      await f.repository.saveOutbound({ ...publicDelivery, id: `newer-${i}`, journalEventIdentity: `newer-event-${i}`, createdAt: later, updatedAt: later, status: 'delivered' })
    }
    assert.ok(!(await f.repository.listOutbound(projectId, 100)).some(item => item.id === privateDelivery.id))
    for (const name of [...users, 'owner']) assert.equal((await fetch(`${base}${detailPath}`, { headers: headers(name) })).status, name === 'owner' ? 200 : 404)
    await app.store.transaction(async tx => {
      const current = (await tx.resources.getSession(sessionId))!
      await tx.resources.saveSession({ ...current, deletedAt: at })
    })
    assert.equal((await fetch(`${base}${detailPath}`, { headers: headers('owner') })).status, 404, 'deleted Session fails closed even for its owner')
  } finally { await app.close(); await f.close() }
})

test('Channel DTO contract allowlists provider fields and maps connection states without internal data', async () => {
  const { channelRoutes } = await import('../http/routes/channel-routes.js')
  const f = await fixture()
  try {
    const route = channelRoutes.find(item => item.method === 'GET' && item.pattern === '/projects/:projectId/channels')!
    // This assignment also checks the truthful signature union at compile time.
    const verificationMode: import('@wemux/web-contract').FeishuChannelDTO['verificationMode'] = 'signature'
    const hidden = 'INTERNAL_CONFIG_SENTINEL'
    const channels = [
      { ...f.created.channel, config: { ...f.created.channel.config, hidden } },
      { ...f.created.channel, kind: 'feishu', config: { appIdHint: 'app-hint', verificationMode, acceptEventSchema: '2.0', tenantKey: null, hidden } },
      { ...f.created.channel, kind: 'dingtalk', config: { clientIdHint: 'client-hint', robotCode: 'robot', hidden } },
    ]
    for (const state of ['error', 'reconnecting', 'online'] as const) {
      let result: import('@wemux/web-contract').ChannelListDTO | undefined
      await route.handler({
        channels: { list: async () => channels, bindings: async () => [f.binding], deliveries: async () => ({ inbound: [], outbound: [] }) },
        dingTalk: { status: () => ({ state, reconnectAttempt: 2, connectedAt: '2026-01-01T00:00:00Z', lastError: 'connection interrupted', lastFrameAt: hidden }) },
        params: { projectId }, actor: async () => actor,
        json: (status: number, value: import('@wemux/web-contract').ChannelListDTO) => { assert.equal(status, 200); result = value },
      } as never)
      assert.ok(result)
      const text = JSON.stringify(result)
      for (const value of [hidden, f.created.channel.credentialRef, 'credentialRef', '"config"', 'triggerPolicy', 'lastFrameAt']) assert.ok(!text.includes(value))
      assert.equal(result.items[1].kind === 'feishu' && result.items[1].verificationMode, 'signature')
      const dingTalk = result.items[2]
      assert.equal(dingTalk.kind, 'dingtalk')
      if (dingTalk.kind !== 'dingtalk') assert.fail('wrong Channel kind')
      assert.deepEqual(dingTalk.connection, { state: state === 'error' ? 'offline' : state === 'reconnecting' ? 'connecting' : 'online', reconnectAttempt: 2, connectedAt: '2026-01-01T00:00:00Z', lastError: 'connection interrupted' })
    }
  } finally { await f.close() }
})

test('HTTP Channel create, rotate and enable results project credentials while preserving one-time tokens', async () => {
  const { createWemuxServer } = await import('../server.ts')
  const { administratorEmail, seedAdministrator } = await import('./fixtures/administrator.ts')
  const f = await fixture()
  const app = createWemuxServer({ databasePath: f.path, administratorEmails: [administratorEmail], mail: {}, google: {}, channelEncryptionKey: 'channel-test-key' })
  try {
    const admin = await seedAdministrator(app.store)
    const { project } = await app.service.ensureDefaultEnvironment(admin.userId)
    const base = await app.listen(0), headers = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
    const path = `${base}/api/projects/${project.id}/channels`
    const post = async (url: string, body: unknown, status: number) => {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
      assert.equal(response.status, status)
      const result = await response.json() as import('@wemux/web-contract').CreatedChannelDTO
      assert.ok(!('credentialRef' in result.channel)); assert.ok(!('config' in result.channel))
      return result
    }
    const create = { requestId: 'http-create', name: 'Safe HTTP Channel', kind: 'generic_webhook', callbackUrl: null, sourceCidrs: [] }
    const created = await post(path, create, 201)
    assert.ok(created.issuedToken)
    const repeated = await post(path, create, 201)
    assert.equal(repeated.issuedToken, undefined); assert.equal(repeated.replayed, true)
    const rotated = await post(`${path}/${created.channel.id}/token/rotate`, { requestId: 'http-rotate', expectedRevision: 1 }, 200)
    assert.ok(rotated.issuedToken); assert.notEqual(rotated.issuedToken, created.issuedToken)
    const disabled = await post(`${path}/${created.channel.id}/enabled`, { requestId: 'http-disable', expectedRevision: 2, enabled: false }, 200)
    assert.equal(disabled.channel.enabled, false)
  } finally { await app.close(); await f.close() }
})
