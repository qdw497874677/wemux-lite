import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const approvals = await readFile(new URL('../src/features/approvals/approvals-page.tsx', import.meta.url), 'utf8')
const timeline = await readFile(new URL('../src/features/timeline/timeline-page.tsx', import.meta.url), 'utf8')
const client = await readFile(new URL('../src/features/projections/projection-client.ts', import.meta.url), 'utf8')

test('approvals page preserves single-item decisions, freshness, filters, and distinct empty states', () => {
  assert.match(approvals, /每次只处理一条审批/)
  assert.match(approvals, /FreshnessBadge/)
  assert.match(approvals, /筛选来源/)
  assert.match(approvals, /ProjectionEmpty filtered=/)
  assert.doesNotMatch(approvals, /批量批准|批量拒绝/)
  assert.match(approvals, /InspectorHost/)
})

test('timeline page groups events and supports project/source filters and cursor loading', () => {
  assert.match(timeline, /groupByKey/)
  assert.match(timeline, /筛选项目/)
  assert.match(timeline, /筛选事件来源/)
  assert.match(timeline, /加载更多/)
  assert.match(timeline, /ProjectionSkeleton/)
})

test('projection client uses CSRF only for decision writes and returns cursor page shapes', () => {
  assert.match(client, /x-csrf-token/)
  assert.match(client, /CursorPage/)
  assert.match(client, /`\/approvals/)
  assert.match(client, /`\/timeline/)
})
