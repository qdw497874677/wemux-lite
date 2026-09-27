import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEvent } from '../src/index.js'
import { projectAgentEventToSessionPayload } from '../src/index.js'
import type { ApprovalId, Timestamp, ToolCallId, TurnId } from '@wemux/domain'

const turnId = 'turn-1' as TurnId
const base = (overrides: Partial<AgentEvent>): AgentEvent => ({
  id: 'event-1',
  invocationId: turnId,
  author: 'pi',
  actions: {},
  timestamp: '2026-01-01T00:00:00.000Z' as Timestamp,
  ...overrides,
})

test('projects public assistant content into the durable Session Journal', () => {
  const event = base({ content: { role: 'model', parts: [{ text: '你好' }] }, partial: true })
  assert.deepEqual(projectAgentEventToSessionPayload(event, turnId), { kind: 'assistant.text.delta', turnId, text: '你好' })
})

test('projects normalized usage and provider tool events without exposing transport fields', () => {
  const usage = { scope: 'operation' as const, subjectId: turnId, inputTokens: 2, outputTokens: 3, totalTokens: 5 }
  assert.deepEqual(projectAgentEventToSessionPayload(base({ customMetadata: { wemux: { usage } } }), turnId), { kind: 'usage.updated', turnId, usage })

  const toolCallId = 'tool-1' as ToolCallId
  assert.deepEqual(projectAgentEventToSessionPayload(base({ customMetadata: { provider: { kind: 'tool.started', toolCallId, toolName: 'read', input: { path: '/tmp/a' } } } }), turnId), {
    kind: 'tool.started', turnId, toolCallId, toolName: 'read', input: { path: '/tmp/a' },
  })
})

test('projects approval lifecycle and terminal taxonomy into the durable journal', () => {
  const approvalId = 'approval-1' as ApprovalId
  assert.deepEqual(projectAgentEventToSessionPayload(base({ customMetadata: { wemux: { approval: { kind: 'requested', id: approvalId, action: { command: 'rm' }, reason: '需要确认' } }, provider: { kind: 'approval.requested', approvalId, action: null } } }), turnId), {
    kind: 'approval.requested', turnId, approvalId, action: { command: 'rm' }, reason: '需要确认',
  })
  assert.deepEqual(projectAgentEventToSessionPayload(base({ customMetadata: { wemux: { approval: { kind: 'resolved', id: approvalId, decision: 'deny' } }, provider: { kind: 'approval.resolved' } } }), turnId), {
    kind: 'approval.resolved', turnId, approvalId, decision: 'deny',
  })
  assert.deepEqual(projectAgentEventToSessionPayload(base({ customMetadata: { wemux: { terminal: 'failed', error: { code: 'agent-error', message: 'connection refused', abortReason: 'provider_error', failureReason: 'agent_error.provider_network', retryable: true } } } }), turnId), {
    kind: 'turn.finished', turnId, outcome: 'failed', failure: { code: 'agent-error', message: 'connection refused', abortReason: 'provider_error', failureReason: 'agent_error.provider_network', retryable: true },
  })
  assert.equal(projectAgentEventToSessionPayload(base({ customMetadata: { wemux: { nativeSession: 'native-1' as never } } }), turnId), null)
})

test('projects runtime notices including retry budget and drops malformed metadata', () => {
  assert.deepEqual(projectAgentEventToSessionPayload(base({ customMetadata: { provider: { kind: 'runtime.notice', level: 'warning', code: 'agent.auto-retry', message: '运行时错误，正在自动重试：429', retry: { attempt: 2, maxAttempts: 10, delayMs: 3000 } } } }), turnId), {
    kind: 'runtime.notice', level: 'warning', code: 'agent.auto-retry', message: '运行时错误，正在自动重试：429', retry: { attempt: 2, maxAttempts: 10, delayMs: 3000 },
  })
  assert.deepEqual(projectAgentEventToSessionPayload(base({ customMetadata: { provider: { kind: 'runtime.notice' } } }), turnId), {
    kind: 'runtime.notice', level: 'warning', code: 'agent.notice', message: '运行时提示',
  })
  assert.deepEqual(projectAgentEventToSessionPayload(base({ customMetadata: { provider: { kind: 'runtime.notice', level: 'info', code: 'x', message: 'y', retry: { attempt: 'nope' } } } }), turnId), {
    kind: 'runtime.notice', level: 'info', code: 'x', message: 'y', retry: { attempt: 1, maxAttempts: null, delayMs: null },
  })
})

test('projects stream kinds, compaction and usage scope metadata that the server validator whitelists', () => {
  assert.deepEqual(projectAgentEventToSessionPayload(base({ content: { role: 'model', parts: [{ text: 'plan' }] }, partial: true, streamKind: 'plan_text' }), turnId), { kind: 'assistant.text.delta', turnId, text: 'plan', streamKind: 'plan_text' })
  const toolCallId = 'tool-file' as ToolCallId
  assert.deepEqual(projectAgentEventToSessionPayload(base({ streamKind: 'file_change_output', customMetadata: { provider: { kind: 'tool.output.delta', toolCallId, text: 'updated a.ts' } } }), turnId), { kind: 'tool.output.delta', turnId, toolCallId, text: 'updated a.ts', streamKind: 'file_change_output' })
  assert.deepEqual(projectAgentEventToSessionPayload(base({ customMetadata: { provider: { kind: 'compaction.started', reason: 'auto' } } }), turnId), { kind: 'compaction.started', turnId, reason: 'auto' })
  assert.deepEqual(projectAgentEventToSessionPayload(base({ customMetadata: { provider: { kind: 'compaction.finished', summary: '摘要' } } }), turnId), { kind: 'compaction.finished', turnId, summary: '摘要' })
})
