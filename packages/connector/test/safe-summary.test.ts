import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeAgentResult, summarizeJournal } from '../src/index.js'

test('redacts sensitive keys, credentials, JWTs, cookies, and userinfo URLs', () => {
  const summary = summarizeJournal({
    Authorization: 'Bearer abc',
    cookie: 'sid=secret',
    nested: { accessToken: 'token-value' },
    jwt: 'aaaa.bbbb.cccc',
    userinfo: 'https://user:password@example.com/path',
    url: 'https://example.com/path?api_key=secret',
    safeUrl: 'https://example.com/path?q=ok',
  }) as Record<string, unknown>
  assert.equal(summary.Authorization, '[redacted]')
  assert.equal(summary.cookie, '[redacted]')
  assert.deepEqual(summary.nested, { accessToken: '[redacted]' })
  assert.equal(summary.jwt, '[redacted]')
  assert.equal(summary.userinfo, '[redacted-url]')
  assert.equal(summary.url, '[redacted-url]')
  assert.equal(summary.safeUrl, 'https://example.com')
})

test('agent and journal profiles have distinct string and total-size limits', () => {
  const long = 'x'.repeat(20 * 1024)
  assert.deepEqual(summarizeAgentResult({ output: long }), { output: long })
  const journal = summarizeJournal({ output: long }) as { output: string }
  assert.ok(journal.output.endsWith('[truncated]'))
  assert.ok(journal.output.length < 300)

  const oversizedJournal = Object.fromEntries(
    Array.from({ length: 50 }, (_, outer) => [
      `group${outer}`,
      Object.fromEntries(Array.from({ length: 5 }, (_, inner) => [`value${inner}`, 'x'.repeat(256)])),
    ]),
  )
  assert.equal(summarizeJournal(oversizedJournal), '[truncated]')
  assert.notEqual(summarizeAgentResult(oversizedJournal), '[truncated]')
})

test('journal profile bounds depth and nodes while agent profile retains more', () => {
  const deep = { a: { b: { c: { d: { e: 'value' } } } } }
  assert.deepEqual(summarizeJournal(deep), { a: { b: { c: { d: { e: '[truncated]' } } } } })
  assert.deepEqual(summarizeAgentResult(deep), deep)
  const wide = Array.from({ length: 300 }, (_, index) => ({ index }))
  const journal = summarizeJournal(wide) as unknown[]
  assert.equal(journal.length, 20)
  assert.equal((summarizeAgentResult(wide) as unknown[]).length, 300)
})

test('never invokes malicious getters and rejects non-plain or pollution-shaped objects', () => {
  let getterCalls = 0
  const hostile = Object.create(null) as Record<string, unknown>
  Object.defineProperty(hostile, 'safe', { enumerable: true, value: 'ok' })
  Object.defineProperty(hostile, 'boom', { enumerable: true, get() { getterCalls += 1; throw new Error('boom') } })
  Object.defineProperty(hostile, '__proto__', { enumerable: true, value: { polluted: true } })
  const summary = summarizeJournal(hostile) as Record<string, unknown>
  assert.equal(summary.safe, 'ok')
  assert.equal(summary.boom, '[unavailable]')
  assert.equal(Object.hasOwn(summary, '__proto__'), false)
  assert.equal(getterCalls, 0)
  assert.equal(summarizeJournal(new Date()), '[unavailable]')
  assert.equal(({} as { polluted?: boolean }).polluted, undefined)
})
