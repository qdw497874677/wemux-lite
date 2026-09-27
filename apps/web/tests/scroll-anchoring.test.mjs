import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createScrollAnchorState,
  reduceScrollAnchorState,
} from '../src/features/sessions/scroll-anchoring.ts'

test('follows new content while the reader is at the bottom', () => {
  const initial = createScrollAnchorState({ distanceFromBottom: 12 })
  const next = reduceScrollAnchorState(initial, { type: 'content-added', count: 1 })

  assert.deepEqual(next, {
    isAtBottom: true,
    unreadCount: 0,
    shouldScrollToBottom: true,
  })
})

test('locks the reading position after the reader scrolls upward', () => {
  const initial = createScrollAnchorState({ distanceFromBottom: 0 })
  const scrolled = reduceScrollAnchorState(initial, {
    type: 'viewport-scrolled',
    distanceFromBottom: 96,
  })
  const next = reduceScrollAnchorState(scrolled, { type: 'content-added', count: 1 })

  assert.deepEqual(next, {
    isAtBottom: false,
    unreadCount: 1,
    shouldScrollToBottom: false,
  })
})

test('counts new messages while locked and clears the count after jumping down', () => {
  const locked = createScrollAnchorState({ distanceFromBottom: 120 })
  const withMessages = reduceScrollAnchorState(
    reduceScrollAnchorState(locked, { type: 'content-added', count: 2 }),
    { type: 'content-added', count: 3 },
  )
  const followed = reduceScrollAnchorState(withMessages, { type: 'jump-to-bottom' })

  assert.equal(withMessages.unreadCount, 5)
  assert.deepEqual(followed, {
    isAtBottom: true,
    unreadCount: 0,
    shouldScrollToBottom: true,
  })
})
