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

test('projects approval events and ignores terminal/native-session metadata owned by other projections', () => {
  const approvalId = 'approval-1' as ApprovalId
  assert.deepEqual(projectAgentEventToSessionPayload(base({ customMetadata: { provider: { kind: 'approval.requested', approvalId, action: { command: 'rm' }, reason: '需要确认' } } }), turnId), {
    kind: 'approval.requested', turnId, approvalId, action: { command: 'rm' }, reason: '需要确认',
  })
  assert.equal(projectAgentEventToSessionPayload(base({ customMetadata: { wemux: { terminal: 'completed' } } }), turnId), null)
  assert.equal(projectAgentEventToSessionPayload(base({ customMetadata: { wemux: { nativeSession: 'native-1' as never } } }), turnId), null)
})
