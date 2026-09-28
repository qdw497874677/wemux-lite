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
