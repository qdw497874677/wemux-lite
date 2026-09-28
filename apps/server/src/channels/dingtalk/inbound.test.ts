import assert from 'node:assert/strict'
import test from 'node:test'
import { DingTalkInboundHandler } from './inbound.ts'
import type { ChannelId } from '@wemux/connector'
import type { DingTalkStreamFrame } from './stream-client.ts'

const base = { msgId: 'msg-1', conversationId: 'cid-1', senderStaffId: 'staff-1', robotCode: 'robot-1', msgtype: 'text', text: { content: '  hello  ' }, sessionWebhook: 'https://example.test/reply', createAt: 1_788_220_800_000 }
function frame(payload: Record<string, unknown>): DingTalkStreamFrame { return { type: 'CALLBACK', headers: { messageId: 'frame-1', topic: '/v1.0/im/bot/messages/get' }, data: JSON.stringify(payload) } }
async function run(payload: Record<string, unknown>, robotCode = 'robot-self') { const messages: unknown[] = [], audits: unknown[] = []; let acks = 0; await new DingTalkInboundHandler({ channelId: 'channel-1' as ChannelId, robotCode, onMessage: async message => { messages.push(message) }, onAudit: audit => { audits.push(audit) } }).handle(frame(payload), () => { acks += 1 }); return { messages, audits, acks } }

test('private text triggers and trims content', async () => { const result = await run({ ...base, conversationType: '1', isInAtList: false }); assert.equal(result.acks, 1); assert.equal(result.messages.length, 1); assert.equal((result.messages[0] as { text: string }).text, 'hello') })
test('group only triggers when robot is mentioned', async () => { assert.equal((await run({ ...base, conversationType: '2', isInAtList: false })).messages.length, 0); assert.equal((await run({ ...base, conversationType: '2', isInAtList: true })).messages.length, 1) })
test('filters robot self messages', async () => { const result = await run({ ...base, conversationType: '1', senderStaffId: 'robot-self' }); assert.equal(result.messages.length, 0); assert.equal((result.audits[0] as { reason: string }).reason, 'self_message') })
test('unsupported message type is acknowledged and audited', async () => { const result = await run({ ...base, conversationType: '1', msgtype: 'picture', text: undefined }); assert.equal(result.acks, 1); assert.equal((result.audits[0] as { reason: string }).reason, 'unsupported_message_type') })
test('falls back to conversation and create time identity', async () => { const result = await run({ ...base, msgId: undefined, conversationType: '1' }); assert.equal((result.messages[0] as { eventId: string }).eventId, 'conversation:cid-1:1788220800000') })
