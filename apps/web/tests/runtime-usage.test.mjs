import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const journalUrl = pathToFileURL(new URL('../src/api/journal.ts', import.meta.url).pathname).href
const { projectJournal } = await import(journalUrl)

test('projects the latest usage snapshot for a turn without accumulating duplicates', () => {
  const events = [
    { sessionId: 'session-1', seq: 1, occurredAt: '2026-01-01T00:00:00.000Z', payload: { kind: 'turn.started', turnId: 'turn-1', messageId: 'message-1' } },
    { sessionId: 'session-1', seq: 2, occurredAt: '2026-01-01T00:00:01.000Z', payload: { kind: 'usage.updated', turnId: 'turn-1', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } },
    { sessionId: 'session-1', seq: 3, occurredAt: '2026-01-01T00:00:02.000Z', payload: { kind: 'usage.updated', turnId: 'turn-1', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } },
  ]
  const projected = projectJournal(events)
  const usage = projected.timeline.filter(item => item.kind === 'usage')
  assert.equal(usage.length, 1)
  assert.deepEqual(usage[0].usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
})

test('projects approval and compaction lifecycle as readable notices', () => {
  const events = [
    { sessionId: 'session-1', seq: 1, occurredAt: '2026-01-01T00:00:00.000Z', payload: { kind: 'approval.requested', turnId: 'turn-1', approvalId: 'approval-1', action: { tool: 'write' }, reason: '' } },
    { sessionId: 'session-1', seq: 2, occurredAt: '2026-01-01T00:00:01.000Z', payload: { kind: 'compaction.started', turnId: 'turn-1', reason: '' } },
    { sessionId: 'session-1', seq: 3, occurredAt: '2026-01-01T00:00:02.000Z', payload: { kind: 'compaction.finished', turnId: 'turn-1' } },
  ]
  assert.deepEqual(projectJournal(events).timeline.map(item => item.kind === 'notice' ? item.text : ''), ['\u7b49\u5f85\u5ba1\u6279', '\u6b63\u5728\u538b\u7f29\u4e0a\u4e0b\u6587', '\u4e0a\u4e0b\u6587\u538b\u7f29\u5b8c\u6210'])
})
