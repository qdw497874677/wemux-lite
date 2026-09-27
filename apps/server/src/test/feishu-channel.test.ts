import assert from 'node:assert/strict'
import test from 'node:test'
import { createCipheriv, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { AesGcmSecretCodec } from '@wemux/connector'
import { verifyFeishuEnvelope, feishuChallenge } from '../channels/feishu/verify.js'
import { normalizeFeishuEvent, persistFeishuInbound, feishuInboundRetentionMs } from '../channels/feishu/inbound.js'
import { FeishuTokenProvider } from '../channels/feishu/token-provider.js'
import { FeishuReplyPusher, idempotencyUuid, plainText, splitCodePoints } from '../channels/feishu/reply-pusher.js'
import { FeishuAdapter } from '../channels/feishu/adapter.js'

const fixtureUrl = new URL('./fixtures/feishu/v2024-11/', import.meta.url)
const challenge = Buffer.from(await readFile(new URL('challenge.json', fixtureUrl)))
const message = JSON.parse(await readFile(new URL('message.json', fixtureUrl), 'utf8')) as Record<string, unknown>
const secrets = { verificationToken: 'fixture-verification-token', encryptKey: 'fixture-encrypt-key' }

test('verify accepts official-format challenge and encrypted/non-encrypted envelopes', () => {
  const plain = verifyFeishuEnvelope(challenge, secrets)
  assert.equal(feishuChallenge(plain.value), 'fixture-challenge')
  const encrypted = verifyFeishuEnvelope(Buffer.from(JSON.stringify({ encrypt: encrypt(JSON.parse(challenge.toString()), secrets.encryptKey) })), secrets)
  assert.equal(encrypted.encrypted, true); assert.equal(feishuChallenge(encrypted.value), 'fixture-challenge')
  assert.throws(() => verifyFeishuEnvelope(challenge, { ...secrets, verificationToken: 'wrong' }), /verification token/)
  assert.throws(() => verifyFeishuEnvelope(Buffer.from('{"encrypt":"bad"}'), secrets), /encrypted event/)
})

test('inbound normalizes p2p/group messages and ignores bot, missing mention, unsupported and out-of-order events', async () => {
  assert.equal(normalizeFeishuEvent(message).text, '你好 Wemux')
  const group = clone(message); group.header.event_id = 'group'; group.event.message.chat_type = 'group'; group.event.message.mentions = [{ key: '@_user_1', id: { open_id: 'ou_bot' } }]
  assert.equal(normalizeFeishuEvent(group).mentionedBot, true)
  const persisted: unknown[] = []
  const repository = { purgeInboundBefore: async () => 0, acceptInbound: async ({ delivery }: any) => { persisted.push(delivery); return { kind: 'accepted', delivery } } }
  const channel = { id: 'channel-1', projectId: 'project-1', kind: 'feishu' } as any
  const first = await persistFeishuInbound({ repository: repository as any, channel, envelope: message, receivedAt: new Date('2026-01-08T00:00:00Z') })
  assert.equal(first.kind, 'accepted'); assert.equal(feishuInboundRetentionMs, 7 * 24 * 60 * 60 * 1000)
  const noMention = clone(group); noMention.header.event_id = 'old-event'; noMention.event.message.mentions = []
  assert.equal((await persistFeishuInbound({ repository: repository as any, channel, envelope: noMention })).kind, 'ignored')
  const bot = clone(message); bot.header.event_id = 'bot'; bot.event.sender.sender_type = 'app'
  assert.match((await persistFeishuInbound({ repository: repository as any, channel, envelope: bot })).reason ?? '', /机器人/)
  const unsupported = clone(message); unsupported.header.event_id = 'unsupported'; unsupported.header.event_type = 'im.chat.updated_v1'
  assert.match((await persistFeishuInbound({ repository: repository as any, channel, envelope: unsupported })).reason ?? '', /不支持/)
  assert.equal(persisted.length, 4)
})

test('token provider single-flights, refreshes early, retries one 401 and backs off 429', async () => {
  let now = 0, tokenCalls = 0, apiCalls = 0, sleeps = 0
  const fetcher = async (input: string | URL, init?: RequestInit) => {
    if (String(input).includes('/auth/')) { tokenCalls++; if (tokenCalls === 1) return new Response('', { status: 429, headers: { 'retry-after': '0.001' } }); return Response.json({ code: 0, tenant_access_token: `token-${tokenCalls}`, expire: 120 }) }
    apiCalls++; return new Response('', { status: apiCalls === 1 ? 401 : 200 })
  }
  const provider = new FeishuTokenProvider(fetcher as typeof fetch, () => now, async () => { sleeps++ })
  const credential = { appId: 'app', appSecret: 'secret', revision: 2 }
  const [a, b] = await Promise.all([provider.token('channel-1' as any, credential), provider.token('channel-1' as any, credential)])
  assert.equal(a, b); assert.equal(tokenCalls, 2); assert.equal(sleeps, 1)
  now = 61_000; await provider.token('channel-1' as any, credential); assert.equal(tokenCalls, 3)
  const response = await provider.authorizedFetch('channel-1' as any, credential, 'https://api.fixture/messages', {})
  assert.equal(response.status, 200); assert.equal(apiCalls, 2); assert.equal(tokenCalls, 4)
})

test('reply pusher strips rich text, splits by code point and uses stable UUID idempotency', async () => {
  const requests: Array<{ body: any; key: string | null }> = []
  const tokens = { authorizedFetch: async (_id: unknown, _credential: unknown, _url: unknown, init: RequestInit) => { requests.push({ body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('x-idempotency-key') }); return Response.json({ code: 0 }) } }
  const pusher = new FeishuReplyPusher(tokens as any, 'https://fixture/open-apis')
  const text = `[链接](https://example.com) ${'😀'.repeat(4001)}`
  const result = await pusher.push({ id: 'delivery-1', channelId: 'channel-1', callbackUrl: 'oc_chat', content: text } as any, { appId: 'a', appSecret: 's', revision: 1 })
  assert.equal(result.kind, 'delivered'); assert.equal(requests.length, 2); assert.ok(Array.from(JSON.parse(requests[0]!.body.content).text).length <= 4000)
  assert.equal(requests[0]!.body.uuid, idempotencyUuid('delivery-1', 0)); assert.equal(requests[0]!.key, requests[0]!.body.uuid)
  assert.equal(plainText('[x](u) **b**'), 'x b'); assert.deepEqual(splitCodePoints('😀a', 1), ['😀', 'a'])
})

test('adapter ACKs unsupported events after durable ignored audit and deduplicates event_id', async () => {
  const codec = new AesGcmSecretCodec({ currentKey: 'fixture-key' }), channel = { id: 'channel-1', projectId: 'project-1', name: 'Feishu', kind: 'feishu', credentialRef: 'credential-1', credentialAvailability: 'available', enabled: true, revision: 1, config: { appIdHint: 'cli…ture', verificationMode: 'verification_token', acceptEventSchema: '2.0', tenantKey: null }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any
  const ciphertext = await codec.encode(JSON.stringify({ appId: 'cli_fixture', appSecret: 'secret', verificationToken: secrets.verificationToken, encryptKey: null }), { owner: { kind: 'channel', id: channel.id }, credentialId: channel.credentialRef, authType: 'custom_credential', revision: 1 })
  const seen = new Map<string, any>()
  const repository = { getChannel: async () => channel, getSecret: async () => ({ credentialId: channel.credentialRef, channelId: channel.id, ciphertext, revision: 1 }), purgeInboundBefore: async () => 0, acceptInbound: async ({ delivery }: any) => { const old = seen.get(delivery.providerEventId); if (old) return { kind: 'duplicate', delivery: old }; seen.set(delivery.providerEventId, delivery); return { kind: 'accepted', delivery } } }
  const adapter = new FeishuAdapter(repository as any, codec)
  const request = { channelId: channel.id, headers: {}, body: Buffer.from(JSON.stringify(message)) }
  const accepted = await adapter.handleInbound(request)
  assert.equal(accepted.accepted?.kind, 'accepted'); assert.equal(typeof accepted.afterAck, 'function'); await accepted.afterAck?.()
  assert.equal((await adapter.handleInbound(request)).accepted?.kind, 'duplicate')
})

function encrypt(value: unknown, encryptKey: string): string { const key = createHash('sha256').update(encryptKey).digest(); const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); return Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64') }
function clone(value: unknown): any { return JSON.parse(JSON.stringify(value)) }
