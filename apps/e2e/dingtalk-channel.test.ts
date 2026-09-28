import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { DingTalkStreamClient } from '../server/src/channels/dingtalk/stream-client.ts'
import { DingTalkInboundHandler } from '../server/src/channels/dingtalk/inbound.ts'
import { DingTalkReplyPusher } from '../server/src/channels/dingtalk/reply-pusher.ts'

function listen(server: ReturnType<typeof createServer>): Promise<number> { return new Promise((resolve, reject) => { server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)); server.once('error', reject) }) }

test('DingTalk Stream fake websocket full path deduplicates inbound and pushes reply', async () => {
  const replies: unknown[] = []
  const http = createServer(async (request, response) => {
    if (request.url?.startsWith('/gateway')) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ endpoint: `ws://127.0.0.1:${(http.address() as { port: number }).port}/stream`, ticket: 'fixture-ticket' })); return }
    if (request.url?.startsWith('/session-webhook')) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); replies.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); response.end('{}'); return }
    response.statusCode = 404; response.end()
  })
  const port = await listen(http), websocket = new WebSocketServer({ server: http, path: '/stream' })
  const received = new Set<string>(), sessions: Array<{ id: string; prompt: string }> = [], acks: unknown[] = []
  const pusher = new DingTalkReplyPusher()
  const inbound = new DingTalkInboundHandler({ channelId: 'channel-dingtalk', robotCode: 'robot-code', onMessage: async message => { if (received.has(message.eventId)) return; received.add(message.eventId); sessions.push({ id: `session-${message.conversationId}`, prompt: message.text }); await pusher.push({ sessionWebhook: message.sessionWebhook }, `已收到：${message.text}`, `reply:${message.eventId}`) } })
  websocket.on('connection', (socket, request) => {
    assert.equal(new URL(request.url ?? '', `http://127.0.0.1:${port}`).searchParams.get('ticket'), 'fixture-ticket')
    socket.on('message', data => { acks.push(JSON.parse(String(data))) })
    const frame = { specVersion: '1.0', type: 'CALLBACK', headers: { messageId: 'frame-e2e', topic: '/v1.0/im/bot/messages/get' }, data: JSON.stringify({ msgId: 'msg-e2e', conversationId: 'cid-e2e', conversationType: '1', senderStaffId: 'staff-e2e', text: { content: '  全链路测试  ' }, isInAtList: false, sessionWebhook: `http://127.0.0.1:${port}/session-webhook`, robotCode: 'robot-code', msgtype: 'text', createAt: Date.now() }) }
    socket.send(JSON.stringify(frame)); socket.send(JSON.stringify(frame))
  })
  const client = new DingTalkStreamClient({ credential: { clientId: 'fixture-client', clientSecret: 'fixture-secret' }, gatewayOpenUrl: `http://127.0.0.1:${port}/gateway`, onFrame: (frame, ack) => inbound.handle(frame, ack) })
  await client.start()
  await new Promise<void>((resolve, reject) => { const deadline = Date.now() + 3_000; const poll = () => { if (replies.length === 1 && acks.length === 2) resolve(); else if (Date.now() > deadline) reject(new Error('DingTalk E2E timeout')); else setTimeout(poll, 20) }; poll() })
  assert.deepEqual(sessions, [{ id: 'session-cid-e2e', prompt: '全链路测试' }]); assert.equal(replies.length, 1); assert.equal((replies[0] as { msgtype: string }).msgtype, 'markdown'); assert.equal(acks.length, 2)
  await client.stop(); await new Promise<void>(resolve => websocket.close(() => resolve())); await new Promise<void>(resolve => http.close(() => resolve()))
})
