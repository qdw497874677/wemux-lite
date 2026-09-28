import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const approvals = await readFile(new URL('../src/features/approvals/approvals-page.tsx', import.meta.url), 'utf8')
const timeline = await readFile(new URL('../src/features/timeline/timeline-page.tsx', import.meta.url), 'utf8')
const client = await readFile(new URL('../src/features/projections/projection-client.ts', import.meta.url), 'utf8')
const projectionUi = await readFile(new URL('../src/features/projections/projection-ui.tsx', import.meta.url), 'utf8')

test('approvals page preserves single-item decisions and presents grouped filters and spacious status rows', () => {
  assert.match(approvals, /每次只处理一条审批/)
  assert.match(approvals, /aria-labelledby="approval-filter-title"/)
  assert.match(approvals, /筛选审批/)
  assert.match(approvals, /SelectTrigger aria-label="筛选来源"/)
  assert.match(approvals, /ApprovalStatusBadge status=\{item\.status\}/)
  assert.match(approvals, /px-4 py-3\.5/)
  assert.match(approvals, /ProjectionEmpty filtered=/)
  assert.doesNotMatch(approvals, /批量批准|批量拒绝/)
  assert.match(approvals, /InspectorHost/)
})

test('timeline page groups events into separated time, type, and description regions', () => {
  assert.match(timeline, /groupByKey/)
  assert.match(timeline, /aria-labelledby="timeline-filter-title"/)
  assert.match(timeline, /SelectTrigger aria-label="筛选事件来源"/)
  assert.match(timeline, /font-mono text-xs font-semibold tabular-nums/)
  assert.match(timeline, /\{event\.action\}/)
  assert.match(timeline, /leading-6/)
  assert.match(timeline, /加载更多/)
  assert.match(timeline, /ProjectionSkeleton/)
})

test('approval status badge covers pending, approved, rejected, and expired visual states', () => {
  assert.match(projectionUi, /pending:.*amber/)
  assert.match(projectionUi, /approved:.*emerald/)
  assert.match(projectionUi, /denied:.*red/)
  assert.match(projectionUi, /expired:.*zinc/)
  assert.match(projectionUi, /size-1\.5 rounded-full/)
})

test('projection client uses CSRF only for decision writes and returns cursor page shapes', () => {
  assert.match(client, /x-csrf-token/)
  assert.match(client, /CursorPage/)
  assert.match(client, /`\/approvals/)
  assert.match(client, /`\/timeline/)
})
