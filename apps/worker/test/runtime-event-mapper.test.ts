import assert from 'node:assert/strict'
import test from 'node:test'
import type { OperationId } from '@wemux/domain'
import { mapRuntimeRecord } from '../src/agents/runtime-event-mapper.js'

const operationId = 'op-test' as OperationId

test('maps tool lifecycle and approval requests without provider-specific UI fields', () => {
  const started = mapRuntimeRecord('pi', operationId, { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'pwd' } })
  assert.equal(started[0]?.kind, 'event')
  assert.deepEqual(started[0]?.kind === 'event' ? started[0].event : null, { kind: 'tool.started', toolCallId: 'call-1', toolName: 'bash', input: { command: 'pwd' } })
  const approval = mapRuntimeRecord('pi', operationId, { type: 'approval_required', approvalId: 'approval-1', action: { command: 'rm -rf /tmp/x' }, reason: 'destructive' })
  assert.equal(approval[0]?.kind === 'event' ? approval[0].event.kind : null, 'approval.requested')
})

test('maps usage, compaction, and terminal outcomes', () => {
  const usage = mapRuntimeRecord('claude', operationId, { type: 'usage', usage: { input_tokens: 4, output_tokens: 7, cache_read_input_tokens: 2 }, cost_usd: 0.01 })
  assert.deepEqual(usage[0]?.kind === 'event' ? usage[0].event : null, { kind: 'usage.updated', usage: { scope: 'operation', subjectId: operationId, source: 'runtime', revision: 1, completeness: 'complete', inputTokens: 4, outputTokens: 7, cacheReadTokens: 2, totalTokens: 11, costUsd: 0.01, currency: 'USD' } })
  assert.equal(mapRuntimeRecord('pi', operationId, { type: 'auto_compaction_start', reason: 'limit' })[0]?.kind === 'event' ? mapRuntimeRecord('pi', operationId, { type: 'auto_compaction_start', reason: 'limit' })[0]!.event.kind : null, 'compaction.started')
  assert.equal(mapRuntimeRecord('pi', operationId, { type: 'done' })[0]?.kind, 'finished')
  assert.equal(mapRuntimeRecord('pi', operationId, { type: 'error', message: 'bad' })[0]?.kind, 'finished')
})
