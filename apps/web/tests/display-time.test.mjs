import assert from 'node:assert/strict'
import test from 'node:test'
import { formatChineseTime, formatRelativeTime } from '../src/lib/display.ts'

const now = Date.parse('2026-03-16T12:00:00.000Z')

test('relative session time stays compact and handles invalid or future values', () => {
  assert.equal(formatRelativeTime('2026-03-16T11:59:30.000Z', now), '刚刚')
  assert.equal(formatRelativeTime('2026-03-16T11:55:00.000Z', now), '5 分钟前')
  assert.equal(formatRelativeTime('2026-03-16T09:00:00.000Z', now), '3 小时前')
  assert.equal(formatRelativeTime('2026-03-14T12:00:00.000Z', now), '2 天前')
  for (const invalid of [null, undefined, '', 'not-a-date']) {
    assert.equal(formatRelativeTime(invalid, now), '时间未知')
  }
  assert.equal(formatRelativeTime('2026-03-16T12:01:00.000Z', now), '刚刚')
})

test('full session time never throws for invalid API values', () => {
  for (const invalid of [null, undefined, '', 'not-a-date']) {
    assert.equal(formatChineseTime(invalid), '时间未知')
  }
})
