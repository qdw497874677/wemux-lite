import assert from 'node:assert/strict'
import test from 'node:test'
import { DingTalkStreamClient, type DingTalkWebSocketLike } from './stream-client.ts'

class FakeSocket implements DingTalkWebSocketLike {
  readyState = 0
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>()
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: never[]) => void): this { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); return this }
  send(data: string): void { this.sent.push(data) }
  close(): void { this.readyState = 3 }
  emit(event: string, ...args: unknown[]): void { for (const listener of this.listeners.get(event) ?? []) (listener as unknown as (...values: unknown[]) => void)(...args) }
}
const credential = { clientId: 'ding-client', clientSecret: 'secret' }
function callbackFrame() { return JSON.stringify({ specVersion: '1.0', type: 'CALLBACK', headers: { messageId: 'frame-1', topic: '/v1.0/im/bot/messages/get' }, data: '{}' }) }

test('opens gateway ticket, connects websocket and acknowledges callback', async () => {
  const socket = new FakeSocket(), frames: string[] = []
  const client = new DingTalkStreamClient({ credential, fetch: async (_url, init) => { assert.equal(JSON.parse(String(init?.body)).clientId, 'ding-client'); return new Response(JSON.stringify({ endpoint: 'ws://fixture.test/stream', ticket: 'ticket-1' }), { status: 200 }) }, webSocketFactory: url => { assert.equal(url, 'ws://fixture.test/stream?ticket=ticket-1'); queueMicrotask(() => { socket.readyState = 1; socket.emit('open') }); return socket }, onFrame: async (frame, ack) => { frames.push(frame.headers?.messageId ?? ''); ack() } })
  await client.start(); socket.emit('message', Buffer.from(callbackFrame())); await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(frames, ['frame-1']); assert.deepEqual(JSON.parse(socket.sent[0]!), { code: 200, headers: { messageId: 'frame-1', contentType: 'application/json' }, message: 'OK', data: '{"response":null}' }); await client.stop()
})

test('classifies gateway authentication failure', async () => {
  const client = new DingTalkStreamClient({ credential, fetch: async () => new Response('{"message":"bad secret"}', { status: 401 }), webSocketFactory: () => new FakeSocket(), onFrame: async () => {} })
  await assert.rejects(client.start(), /钉钉 Stream 鉴权失败/); assert.equal(client.getStatus().state, 'error')
})

test('reconnects with exponential backoff and refreshes ticket', async () => {
  const sockets: FakeSocket[] = [], delays: number[] = [], tickets: string[] = []; let opens = 0
  const client = new DingTalkStreamClient({ credential, random: () => 0.5, setTimeout: (fn, delay) => { delays.push(delay); queueMicrotask(fn); return delay as unknown as ReturnType<typeof setTimeout> }, clearTimeout: () => {}, fetch: async () => { const ticket = `ticket-${++opens}`; tickets.push(ticket); return new Response(JSON.stringify({ endpoint: 'ws://fixture.test/stream', ticket }), { status: 200 }) }, webSocketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); queueMicrotask(() => { socket.readyState = 1; socket.emit('open') }); return socket }, onFrame: async () => {} })
  await client.start(); sockets[0]!.emit('close', 1006, Buffer.from('lost')); await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(delays.slice(0, 1), [1_000]); assert.deepEqual(tickets, ['ticket-1', 'ticket-2']); assert.equal(sockets.length, 2); await client.stop()
})
