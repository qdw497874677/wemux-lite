import assert from 'node:assert/strict'
import test from 'node:test'

import { formatTimelineDateLabel, formatTimelineTime, formatTimelineTimestampTitle, timelineDateLabel } from '../src/lib/conversation-timeline.ts'
import { projectJournal } from '../src/api/journal.ts'

const event = (seq, occurredAt, payload) => ({ sessionId: 'session-1', seq, occurredAt, payload })

test('formats message time and Chinese date labels without inventing missing values', () => {
  const timestamp = new Date(2025, 8, 26, 14, 5, 6).toISOString()
  assert.equal(formatTimelineTime(timestamp), '14:05')
  assert.match(formatTimelineTimestampTitle(timestamp), /2025.*9.*26.*14:05:06/)
  assert.equal(formatTimelineDateLabel(timestamp, new Date(2025, 8, 26, 20)), '\u4eca\u5929')
  assert.equal(formatTimelineDateLabel(timestamp, new Date(2025, 8, 27, 20)), '\u6628\u5929')
  assert.match(formatTimelineDateLabel(timestamp, new Date(2025, 8, 28, 20)), /^9\u670826\u65e5 /)
  assert.equal(formatTimelineTime(undefined), null)
  assert.equal(formatTimelineTimestampTitle('not-a-date'), null)
})

test('inserts separators only before the first timestamped entry and cross-day entries', () => {
  const items = [
    { timestamp: new Date(2025, 8, 26, 9).toISOString() },
    {},
    { timestamp: new Date(2025, 8, 26, 10).toISOString() },
    { timestamp: new Date(2025, 8, 27, 8).toISOString() },
  ]
  const now = new Date(2025, 8, 27, 12)
  assert.equal(timelineDateLabel(items, 0, now), '\u6628\u5929')
  assert.equal(timelineDateLabel(items, 1, now), null)
  assert.equal(timelineDateLabel(items, 2, now), null)
  assert.equal(timelineDateLabel(items, 3, now), '\u4eca\u5929')
})

test('projects AgentEvent timestamps onto messages and tools', () => {
  const projected = projectJournal([
    event(1, '2025-09-26T09:15:00+08:00', { kind: 'message.queued', commandId: 'command-1', messageId: 'message-1', content: 'hello', position: 1 }),
    event(2, '2025-09-26T09:16:00+08:00', { kind: 'turn.started', turnId: 'turn-1', messageId: 'message-1' }),
    event(3, '2025-09-26T09:17:00+08:00', { kind: 'assistant.text.delta', turnId: 'turn-1', text: 'hi' }),
    event(4, '2025-09-27T10:00:00+08:00', { kind: 'tool.started', turnId: 'turn-1', toolCallId: 'tool-1', toolName: 'read', input: { path: 'README.md' } }),
  ])
  const user = projected.timeline.find(item => item.kind === 'message' && item.role === 'user')
  const assistant = projected.timeline.find(item => item.kind === 'message' && item.role === 'assistant')
  const tool = projected.timeline.find(item => item.kind === 'tool')
  assert.equal(user?.timestamp, '2025-09-26T09:15:00+08:00')
  assert.equal(assistant?.timestamp, '2025-09-26T09:17:00+08:00')
  assert.equal(tool?.timestamp, '2025-09-27T10:00:00+08:00')
})
