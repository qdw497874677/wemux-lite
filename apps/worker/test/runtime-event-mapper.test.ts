import assert from 'node:assert/strict'
import test from 'node:test'
import type { OperationId } from '@wemux/domain'
import { mapRuntimeRecord } from '../src/agents/runtime-event-mapper.js'

const operationId = 'op-test' as OperationId

test('Pi tool_execution_end maps camelCase isError from RPC as failed exit', () => {
  const [output, failed] = mapRuntimeRecord('pi', operationId, { type: 'tool_execution_end', toolCallId: 'denied', isError: true, result: { content: [{ type: 'text', text: 'approval_denied' }] } })
  assert.deepEqual(output, { kind: 'event', event: { kind: 'tool.output.delta', toolCallId: 'denied', text: 'approval_denied', streamKind: 'command_output' } })
  assert.deepEqual(failed, { kind: 'event', event: { kind: 'tool.finished', toolCallId: 'denied', exitCode: 1 } })
  const [ok] = mapRuntimeRecord('pi', operationId, { type: 'tool_execution_end', toolCallId: 'ok', isError: false })
  assert.deepEqual(ok, { kind: 'event', event: { kind: 'tool.finished', toolCallId: 'ok', exitCode: 0 } })
})

test('maps tool lifecycle and approval requests without provider-specific UI fields', () => {
  const started = mapRuntimeRecord('pi', operationId, { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'pwd' } })
  assert.equal(started[0]?.kind, 'event')
  assert.deepEqual(started[0]?.kind === 'event' ? started[0].event : null, { kind: 'tool.started', toolCallId: 'call-1', toolName: 'bash', input: { command: 'pwd' }, streamKind: 'command_output' })
  const approval = mapRuntimeRecord('pi', operationId, { type: 'approval_required', approvalId: 'approval-1', action: { command: 'rm -rf /tmp/x' }, reason: 'destructive' })
  assert.equal(approval[0]?.kind === 'event' ? approval[0].event.kind : null, 'approval.requested')
})

test('Pi message_end publishes finalized nested usage and text without inventing interim usage', () => {
  const signals = mapRuntimeRecord('pi', operationId, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '你好' }], usage: { input: 9, output: 2, cacheRead: 1, totalTokens: 12 } } })
  assert.deepEqual(signals.map(signal => signal.kind === 'event' ? signal.event.kind : signal.kind), ['assistant.text.delta', 'usage.updated'])
  assert.deepEqual(signals[1]?.kind === 'event' ? signals[1].event : null, { kind: 'usage.updated', usage: { scope: 'message', subjectId: `${operationId}:message`, source: 'runtime', revision: 1, completeness: 'complete', inputTokens: 9, outputTokens: 2, cacheReadTokens: 1, totalTokens: 12 } })
  assert.deepEqual(mapRuntimeRecord('pi', operationId, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '继续' }, message: { role: 'assistant', usage: { input: 0, output: 0 } } }).map(signal => signal.kind === 'event' ? signal.event.kind : signal.kind), ['assistant.text.delta'])
  const withoutReportedTotal = mapRuntimeRecord('pi', operationId, { type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 7, output: 1 } } })
  assert.deepEqual(withoutReportedTotal.map(signal => signal.kind === 'event' ? signal.event.kind : signal.kind), ['usage.updated'])
  assert.equal(withoutReportedTotal[0]?.kind === 'event' && withoutReportedTotal[0].event.kind === 'usage.updated' ? withoutReportedTotal[0].event.usage.totalTokens : null, undefined)
  assert.deepEqual(mapRuntimeRecord('pi', operationId, { type: 'message_end', message: { role: 'assistant', content: [], usage: { unknown: 1 } } }), [])
  for (const input of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(mapRuntimeRecord('pi', operationId, { type: 'message_end', message: { role: 'assistant', content: [], usage: { input, output: 2 } } }), [])
  }
  assert.deepEqual(mapRuntimeRecord('pi', operationId, { type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 2, output: 1, cost: { total: -0.01 } } } }), [])
})

test('maps usage, compaction, and terminal outcomes', () => {
  const usage = mapRuntimeRecord('claude', operationId, { type: 'usage', usage: { input_tokens: 4, output_tokens: 7, cache_read_input_tokens: 2 }, cost_usd: 0.01 })
  assert.deepEqual(usage[0]?.kind === 'event' ? usage[0].event : null, { kind: 'usage.updated', usage: { scope: 'operation', subjectId: operationId, source: 'runtime', revision: 1, completeness: 'complete', inputTokens: 4, outputTokens: 7, cacheReadTokens: 2, totalTokens: 11, costUsd: 0.01, currency: 'USD' } })
  assert.equal(mapRuntimeRecord('pi', operationId, { type: 'auto_compaction_start', reason: 'limit' })[0]?.kind === 'event' ? mapRuntimeRecord('pi', operationId, { type: 'auto_compaction_start', reason: 'limit' })[0]!.event.kind : null, 'compaction.started')
  assert.equal(mapRuntimeRecord('pi', operationId, { type: 'done' })[0]?.kind, 'finished')
  assert.equal(mapRuntimeRecord('pi', operationId, { type: 'error', message: 'bad' })[0]?.kind, 'finished')
})

test('a terminal record that Pi will retry never finishes the turn', () => {
  // Pi 在 429/额度冷却时先发 agent_end(willRetry=true)，随后自己重试；提前收尾会丢掉重试后的正文。
  assert.deepEqual(mapRuntimeRecord('pi', operationId, { type: 'agent_end', willRetry: true }), [])
  assert.deepEqual(mapRuntimeRecord('pi', operationId, { type: 'turn_end', willRetry: true, messages: [] }), [])
  assert.equal(mapRuntimeRecord('pi', operationId, { type: 'agent_end', willRetry: false })[0]?.kind, 'finished')
})

test('an embedded assistant error becomes a failed turn instead of an empty success', () => {
  // 历史 P0：模型拒绝/额度用尽时 Pi 返回 stopReason=error + errorMessage，content 为空。
  const [signal] = mapRuntimeRecord('pi', operationId, {
    type: 'agent_end',
    messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: '403: {"message":"Usage limit reached","reason":"AccessDenied.Unpurchased"}', provider: 'qwen-token-plan-cn', model: 'glm-5' }],
  })
  assert.equal(signal?.kind, 'finished')
  assert.deepEqual(signal?.kind === 'finished' ? signal.outcome : null, {
    status: 'failed',
    failure: { code: 'agent-error', message: '403: {"message":"Usage limit reached","reason":"AccessDenied.Unpurchased"}' },
  })
  const [unattributed] = mapRuntimeRecord('claude', operationId, { type: 'result', message: { role: 'assistant', stopReason: 'error', provider: 'anthropic', model: 'sonnet' } })
  assert.deepEqual(unattributed?.kind === 'finished' ? unattributed.outcome : null, { status: 'failed', failure: { code: 'agent-error', message: 'claude runtime reported an error for anthropic/sonnet' } })
})

test('an aborted assistant stop reason maps to a cancelled turn', () => {
  const [signal] = mapRuntimeRecord('pi', operationId, { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'aborted' }] })
  assert.deepEqual(signal?.kind === 'finished' ? signal.outcome : null, { status: 'cancelled' })
  const [terminal] = mapRuntimeRecord('pi', operationId, { type: 'turn_end', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', content: [{ type: 'text', text: '你好' }], stopReason: 'stop' }] })
  assert.deepEqual(terminal?.kind === 'finished' ? terminal.outcome : null, { status: 'completed' })
  assert.equal(terminal?.kind === 'finished' ? terminal.outcome.status : null, 'completed')
})

test('auto retry records surface as runtime notices', () => {
  const started = mapRuntimeRecord('pi', operationId, { type: 'auto_retry_start', attempt: 2, maxAttempts: 10, delayMs: 3000, errorMessage: '429 Too Many Requests' })
  assert.deepEqual(started[0]?.kind === 'event' ? started[0].event : null, { kind: 'runtime.notice', level: 'warning', code: 'agent.auto-retry', message: '运行时错误，正在自动重试：429 Too Many Requests', retry: { attempt: 2, maxAttempts: 10, delayMs: 3000 } })
  const recovered = mapRuntimeRecord('pi', operationId, { type: 'auto_retry_end', success: true, attempt: 2 })
  assert.deepEqual(recovered[0]?.kind === 'event' ? recovered[0].event : null, { kind: 'runtime.notice', level: 'info', code: 'agent.retry-recovered', message: '自动重试成功，继续执行', retry: { attempt: 2, maxAttempts: null, delayMs: null } })
  const failed = mapRuntimeRecord('pi', operationId, { type: 'auto_retry_end', success: false, attempt: 10, finalError: 'usage limit reached' })
  assert.deepEqual(failed[0]?.kind === 'event' ? failed[0].event : null, { kind: 'runtime.notice', level: 'warning', code: 'agent.retry-failed', message: '自动重试仍然失败：usage limit reached', retry: { attempt: 10, maxAttempts: null, delayMs: null } })
  // 重试信息缺字段时不能崩：attempt 至少为 1，上限与退避保持未知。
  const partial = mapRuntimeRecord('pi', operationId, { type: 'auto_retry_start', errorMessage: 'boom' })
  assert.deepEqual(partial[0]?.kind === 'event' ? partial[0].event : null, { kind: 'runtime.notice', level: 'warning', code: 'agent.auto-retry', message: '运行时错误，正在自动重试：boom', retry: { attempt: 1, maxAttempts: null, delayMs: null } })
})
