import assert from 'node:assert/strict'
import test from 'node:test'
import { terminalContextText } from '../src/features/terminal/terminal-context.ts'

test('terminal context injects a clearly labeled trailing 20-line window', () => {
  const lines = Array.from({ length: 25 }, (_, index) => `line-${index + 1}`)
  const text = terminalContextText({ active: true, terminalId: 't-1', lines }, 20)
  assert.ok(text.startsWith('[终端上下文]\nline-6'))
  assert.ok(text.endsWith('line-25'))
  assert.equal(text.includes('line-5'), false)
})
