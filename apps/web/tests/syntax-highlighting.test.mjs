import test from 'node:test'
import assert from 'node:assert/strict'
import { LruCache, normalizeSyntaxLanguage, prepareSyntaxHighlight, truncateHighlightCode } from '../src/lib/syntax-highlighting.ts'

test('LRU cache promotes reads and evicts the least recently used entry', () => {
  const cache = new LruCache(2)
  cache.set('a', 1)
  cache.set('b', 2)
  assert.equal(cache.get('a'), 1)
  cache.set('c', 3)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('c'), 3)
})

test('partial streaming bypasses the highlighter', async () => {
  let calls = 0
  const result = await prepareSyntaxHighlight('const x = 1', 'ts', true, 'dark', async () => { calls++; return [] })
  assert.equal(calls, 0)
  assert.equal(result.highlighted, null)
  assert.equal(result.code, 'const x = 1')
})

test('unknown languages fall back to plain text without loading Shiki', async () => {
  let calls = 0
  const result = await prepareSyntaxHighlight('hello', 'wemux-unknown', false, 'dark', async () => { calls++; return [] })
  assert.equal(normalizeSyntaxLanguage('wemux-unknown'), null)
  assert.equal(calls, 0)
  assert.equal(result.highlighted, null)
})

test('large code blocks only send the first 500 lines to the mocked highlighter', async () => {
  const code = Array.from({ length: 503 }, (_, index) => `line ${index + 1}`).join('\n')
  let received = ''
  const result = await prepareSyntaxHighlight(code, 'ts', false, 'dark', async value => { received = value; return [] })
  assert.equal(received.split('\n').length, 500)
  assert.equal(result.code.split('\n').length, 500)
  assert.equal(result.omittedLines, 3)
  assert.equal(truncateHighlightCode(code).omittedLines, 3)
})
