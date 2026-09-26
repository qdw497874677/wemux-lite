import assert from 'node:assert/strict'
import test from 'node:test'
import { applySessionSuggestion, emptySessionSuggestions } from '../src/features/sessions/suggestions.ts'

test('empty-session suggestion fills the draft and focuses the composer without sending', () => {
  let draft = ''
  let focused = false
  let sends = 0
  const controller = { edit(value) { draft = value }, send() { sends++ } }
  const input = { focus() { focused = true } }

  applySessionSuggestion(controller, input, emptySessionSuggestions[1])

  assert.equal(draft, '帮我梳理项目结构')
  assert.equal(focused, true)
  assert.equal(sends, 0)
})
