import assert from 'node:assert/strict'
import test from 'node:test'
import { SESSION_EVENT_KINDS, type SessionEventPayload } from '@wemux/domain'
import { AppError } from '../src/application/errors.js'
import { validateEvent } from '../src/application/validation.js'

/**
 * 每个 kind 一份最小合法 payload。Server 校验白名单曾经漏掉 approvals / compaction / usage，
 * Worker 发上来的这些事件被判 400，用户端只能看到「正在处理」而永远等不到结果。这个测试把
 * 白名单钉在 domain 的 SESSION_EVENT_KINDS 上：新增 kind 不同步校验器就会漏测失败。
 */
const valid: Record<SessionEventPayload['kind'], Record<string, unknown>> = {
  'message.queued': { kind: 'message.queued', commandId: 'c1', messageId: 'm1', content: '你好', position: 1 },
  'message.cancelled': { kind: 'message.cancelled', commandId: 'c1', messageId: 'm1' },
  'turn.started': { kind: 'turn.started', turnId: 't1', messageId: 'm1' },
  'assistant.text.delta': { kind: 'assistant.text.delta', turnId: 't1', text: 'hi' },
  'tool.started': { kind: 'tool.started', turnId: 't1', toolCallId: 'k1', toolName: 'bash' },
  'tool.output.delta': { kind: 'tool.output.delta', turnId: 't1', toolCallId: 'k1', text: 'out' },
  'tool.finished': { kind: 'tool.finished', turnId: 't1', toolCallId: 'k1', exitCode: 0 },
  'approval.requested': { kind: 'approval.requested', turnId: 't1', approvalId: 'a1', action: { toolName: 'bash' } },
  'approval.resolved': { kind: 'approval.resolved', turnId: 't1', approvalId: 'a1', decision: 'approve' },
  'usage.updated': { kind: 'usage.updated', turnId: 't1', usage: { inputTokens: 1, outputTokens: 2, completeness: 'complete' } },
  'compaction.started': { kind: 'compaction.started', turnId: 't1', reason: 'auto' },
  'compaction.finished': { kind: 'compaction.finished', turnId: 't1', summary: '压缩摘要' },
  'runtime.notice': { kind: 'runtime.notice', level: 'warning', code: 'agent.auto-retry', message: '运行时错误，正在自动重试：429', retry: { attempt: 1, maxAttempts: 10, delayMs: 2000 } },
  'turn.finished': { kind: 'turn.finished', turnId: 't1', outcome: 'completed', failure: null },
  'session.runtime.changed': { kind: 'session.runtime.changed', state: 'idle', reason: null },
}

const envelope = (payload: Record<string, unknown>) => ({ sessionId: 's1', seq: 1, occurredAt: new Date().toISOString(), payload })

test('校验器覆盖 domain 声明的全部事件种类', () => {
  assert.deepEqual(Object.keys(valid).sort(), [...SESSION_EVENT_KINDS].sort())
})

for (const kind of SESSION_EVENT_KINDS) {
  test(`事件校验：${kind} 通过`, () => {
    const event = validateEvent(envelope(valid[kind]))
    assert.equal(event.payload.kind, kind)
  })
}

test('未知事件种类被拒为 400', () => {
  assert.throws(() => validateEvent(envelope({ kind: 'runtime.unknown' })), (error: unknown) => error instanceof AppError && error.status === 400)
})

test('runtime.notice 拒绝越界重试信息', () => {
  const notice = (retry: Record<string, unknown>) => envelope({ ...valid['runtime.notice'], retry })
  assert.throws(() => validateEvent(notice({ attempt: 0, maxAttempts: 10, delayMs: 1000 })), (error: unknown) => error instanceof AppError && error.status === 400)
  assert.throws(() => validateEvent(notice({ attempt: 1, maxAttempts: 10, delayMs: 86400001 })), (error: unknown) => error instanceof AppError && error.status === 400)
})

test('runtime.notice 允许省略重试信息与上限', () => {
  assert.equal(validateEvent(envelope({ kind: 'runtime.notice', level: 'info', code: 'agent.retry-recovered', message: '自动重试成功，继续执行', retry: { attempt: 2, maxAttempts: null, delayMs: null } })).payload.kind, 'runtime.notice')
  assert.equal(validateEvent(envelope({ kind: 'runtime.notice', level: 'info', code: 'agent.notice', message: '提示' })).payload.kind, 'runtime.notice')
})