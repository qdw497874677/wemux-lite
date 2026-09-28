import assert from 'node:assert/strict'
import test from 'node:test'
import { DingTalkReplyPusher } from './reply-pusher.ts'

const destination = { sessionWebhook: 'https://example.test/sessionWebhook' }

test('posts markdown to sessionWebhook with idempotency clientId', async () => {
  let url = '', body: Record<string, unknown> = {}
  const result = await new DingTalkReplyPusher({ fetch: async (input, init) => { url = String(input); body = JSON.parse(String(init?.body)); return new Response('{}', { status: 200 }) } }).push(destination, 'hello', 'idem-1')
  assert.equal(result.kind, 'delivered'); assert.match(url, /clientId=/); assert.equal(body.msgtype, 'markdown')
})

test('chunks replies over DingTalk limit', async () => {
  const bodies: string[] = []
  const result = await new DingTalkReplyPusher({ fetch: async (_input, init) => { bodies.push(JSON.parse(String(init?.body)).markdown.text); return new Response('{}', { status: 200 }) }, chunkLimit: 10 }).push(destination, 'abcdefghijklmnopqrstuvw', 'idem-1')
  assert.equal(result.kind, 'delivered'); assert.deepEqual(bodies, ['abcdefghij', 'klmnopqrst', 'uvw'])
})

test('classifies retryable 5xx and permanent 4xx', async () => {
  assert.equal((await new DingTalkReplyPusher({ fetch: async () => new Response('down', { status: 503 }) }).push(destination, 'hello', 'idem')).kind, 'retry')
  assert.equal((await new DingTalkReplyPusher({ fetch: async () => new Response('bad', { status: 400 }) }).push(destination, 'hello', 'idem')).kind, 'dead_letter')
})

test('missing sessionWebhook enters dead letter', async () => { assert.equal((await new DingTalkReplyPusher().push({}, 'hello', 'idem')).kind, 'dead_letter') })
