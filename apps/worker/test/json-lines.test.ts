import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { parseJsonLines } from '../src/agents/json-lines.js'

test('parses chunked JSON lines and skips malformed provider noise', async () => {
  const stream = Readable.from(['{"type":"one"}\n{"type":', '"two"}\nnot-json\n'])
  const values = []
  for await (const value of parseJsonLines(stream)) values.push(value)
  assert.deepEqual(values, [{ type: 'one' }, { type: 'two' }])
})
