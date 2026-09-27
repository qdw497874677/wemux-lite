import assert from 'node:assert/strict'
import test from 'node:test'

import { projectJournal } from '../src/api/journal.ts'
import { normalizeWorkLogEntry } from '../src/features/sessions/work-log.ts'

const at = '2026-03-01T00:00:00.000Z'
const event = (seq, payload) => ({ seq, sessionId: 'session-1', at, payload })

test('journal projects approval requested/resolved lifecycle for replay', () => {
  const journal = projectJournal([
    event(1, { kind: 'approval.requested', turnId: 'turn-1', approvalId: 'approval-1', action: { command: 'rm file' }, reason: 'destructive' }),
    event(2, { kind: 'approval.resolved', turnId: 'turn-1', approvalId: 'approval-1', decision: 'deny' }),
  ])
  assert.equal(journal.pendingApprovals.length, 0)
  assert.deepEqual(journal.approvalHistory, [{ approvalId: 'approval-1', turnId: 'turn-1', decision: 'deny', action: { command: 'rm file' }, reason: 'destructive' }])
  assert.equal(journal.timeline.filter(item => item.kind === 'notice').at(-1)?.text, '审批已拒绝')
})

test('journal replays model changes as visible notices', () => {
  const journal = projectJournal([
    event(1, { kind: 'model.changed', previousModelId: 'provider::old', modelId: 'provider::new' }),
  ])
  assert.equal(journal.timeline.at(-1)?.kind, 'notice')
  assert.equal(journal.timeline.at(-1)?.text, '模型已切换为 provider::new')
})

test('streamKind controls reasoning timeline and work-log action', () => {
  const journal = projectJournal([
    event(1, { kind: 'assistant.text.delta', turnId: 'turn-1', text: 'Inspect files', streamKind: 'plan_text' }),
    event(2, { kind: 'tool.started', turnId: 'turn-1', toolCallId: 'tool-1', toolName: 'opaque-provider-tool', input: { path: 'src/a.ts' }, streamKind: 'file_change_output' }),
  ])
  assert.equal(journal.timeline.some(item => item.kind === 'reasoning' && item.text === 'Inspect files'), false)
  assert.equal(journal.timeline.some(item => item.kind === 'plan'), false)
  const tool = journal.timeline.find(item => item.kind === 'tool')
  assert.ok(tool)
  assert.equal(normalizeWorkLogEntry(tool).action, 'edit')
})

test('failure projection distinguishes disconnects and exposes classification', () => {
  const journal = projectJournal([
    event(1, { kind: 'turn.finished', turnId: 'turn-1', outcome: 'failed', failure: {
      code: 'agent-error', message: 'connection refused', abortReason: 'executor_disconnected',
      failureReason: 'agent_error.provider_network', retryable: true,
    } }),
  ])
  const notice = journal.timeline.find(item => item.kind === 'notice')
  assert.equal(notice?.failureReason, 'agent_error.provider_network')
  assert.match(notice?.text ?? '', /模型服务网络连接中断/)
  assert.doesNotMatch(notice?.text ?? '', /用户已停止/)
})
