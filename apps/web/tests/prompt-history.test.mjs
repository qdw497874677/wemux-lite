import assert from 'node:assert/strict'
import test from 'node:test'
import { PromptHistory, promptHistoryKey } from '../src/lib/prompt-history.ts'

class MemoryStorage {
  values = new Map()
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, value) }
}

test('prompt history persists per session, deduplicates adjacent sends, and keeps the newest 100 entries', () => {
  const storage = new MemoryStorage()
  const first = new PromptHistory('session-a', storage)
  first.push('same prompt')
  first.push('same prompt')
  for (let index = 1; index <= 101; index++) first.push(`prompt ${index}`)

  assert.equal(JSON.parse(storage.getItem(promptHistoryKey('session-a'))).length, 100)
  assert.deepEqual(new PromptHistory('session-a', storage).entries(), Array.from({ length: 100 }, (_, index) => `prompt ${index + 2}`))
  assert.deepEqual(new PromptHistory('session-b', storage).entries(), [])
})

test('prompt history walks backward and forward, stopping at both boundaries', () => {
  const history = new PromptHistory('session', new MemoryStorage())
  history.push('first')
  history.push('second')

  assert.deepEqual(history.step('backward', ''), { value: 'second' })
  assert.deepEqual(history.step('backward', 'second'), { value: 'first' })
  assert.equal(history.step('backward', 'first'), null)
  assert.deepEqual(history.step('forward', 'first'), { value: 'second' })
  assert.deepEqual(history.step('forward', 'second'), { value: '' })
  assert.equal(history.step('forward', ''), null)
})

test('prompt history never captures arrow keys while editing a non-history draft', () => {
  const history = new PromptHistory('session', new MemoryStorage())
  history.push('sent prompt')

  assert.equal(history.step('backward', 'unsent draft'), null)
  assert.equal(history.step('forward', 'unsent draft'), null)
  assert.deepEqual(history.step('backward', 'sent prompt'), null)
  assert.deepEqual(history.step('forward', 'sent prompt'), { value: '' })
})
