import assert from 'node:assert/strict'
import test from 'node:test'
import type { ApprovalId, RuntimeEvent, Timestamp } from '@wemux/domain'
import { encodeRuntimeEvent, parseRuntimeEvent } from '../src/runtime-events.ts'

const base = {
  version: 2 as const,
  operationId: 'op-1' as RuntimeEvent['operationId'],
  sessionId: 'session-1' as RuntimeEvent['sessionId'],
  sequence: 0 as RuntimeEvent['sequence'],
  occurredAt: '2026-03-13T00:00:00.000Z' as Timestamp,
}

test('runtime event codecs round-trip every canonical event kind', () => {
  const events: RuntimeEvent[] = [
    { ...base, type: 'text_delta', text: 'hello' },
    { ...base, type: 'reasoning_delta', text: 'thinking' },
    { ...base, type: 'operation_status', status: 'running' },
    { ...base, type: 'command_catalog', commands: [{ name: 'compact', title: 'Compact', inputSchema: { type: 'object' } }] },
    { ...base, type: 'approval_required', approval: { id: 'approval-1' as ApprovalId, title: 'Approve', description: 'Continue?', status: 'pending' } },
    { ...base, type: 'usage', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, costUsd: 0.01 } },
    { ...base, type: 'authorization', authorization: { state: 'authorized', accountLabel: 'local' } },
    { ...base, type: 'error', error: { code: 'boom', message: 'failed', retryable: true } },
    { ...base, type: 'completed', status: 'succeeded', usage: { totalTokens: 5 } },
  ]
  for (const event of events) assert.deepEqual(parseRuntimeEvent(encodeRuntimeEvent(event)), event)
})

test('runtime event parser rejects malformed envelopes and preserves unknown usage fields', () => {
  assert.equal(parseRuntimeEvent({ ...base, type: 'text_delta' }), null)
  assert.equal(parseRuntimeEvent({ ...base, version: 1, type: 'text_delta', text: 'nope' }), null)
  assert.equal(parseRuntimeEvent({ ...base, sequence: -1, type: 'text_delta', text: 'nope' }), null)
  assert.deepEqual(parseRuntimeEvent({ ...base, type: 'usage', usage: { totalTokens: 7, futureMetric: 42 } }), { ...base, type: 'usage', usage: { totalTokens: 7 } })
})
