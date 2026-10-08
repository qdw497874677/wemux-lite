import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultTaskMetadataJson, parseTaskMetadata, sameTaskMetadata, taskMetadataIntentKey } from '../src/lib/task-metadata.ts'

test('schemaVersion 1 contract: no invented keys, defaults, or null/empty coercion', () => {
  assert.deepEqual(parseTaskMetadata(defaultTaskMetadataJson), { schemaVersion: 1, values: {} })
  for (const raw of ['', '{']) assert.throws(() => parseTaskMetadata(raw), SyntaxError)
  for (const raw of ['null', '[]', 'true', '0', '""', '{"schemaVersion":1,"values":null}', '{"schemaVersion":1,"values":[]}']) assert.throws(() => parseTaskMetadata(raw), /Expected an object/)
  for (const raw of ['{}', '{"schemaVersion":2,"values":{}}', '{"schemaVersion":1,"values":{},"extra":1}']) assert.throws(() => parseTaskMetadata(raw), /schemaVersion 1 and values/)
  assert.throws(() => parseTaskMetadata('{"schemaVersion":1}'), /Expected an object/)
  const raw = '{"schemaVersion":1,"values":{"__proto__":{"x":1},"array":[null,"",{},[],false],"unknown":123}}'
  assert.equal(JSON.stringify(parseTaskMetadata(raw)), raw)
  assert.equal(sameTaskMetadata(raw, raw), true)
  assert.equal(sameTaskMetadata('{', defaultTaskMetadataJson), false)
  assert.equal(sameTaskMetadata('{"schemaVersion":1,"values":{"a":[1,2]}}', '{"schemaVersion":1,"values":{"a":[2,1]}}'), false)
})
test('exact serialized size boundary ignores formatting but does not truncate', () => {
  const base = { schemaVersion: 1, values: { text: '' } }
  const limit = { ...base, values: { text: 'a'.repeat(16000 - JSON.stringify(base).length) } }
  assert.equal(JSON.stringify(limit).length, 16000)
  assert.deepEqual(parseTaskMetadata(JSON.stringify(limit, null, 2)), limit)
  limit.values.text += 'a'
  assert.throws(() => parseTaskMetadata(JSON.stringify(limit)), /Metadata too large/)
})


test('creation metadata identity ignores recursive object order without mutating raw or valid payload', () => {
  const raw = '{"schemaVersion":1,"values":{"a":1,"nested":{"b":null,"a":""},"array":[{"z":2,"a":1},null],"__proto__":{"z":3,"a":4},"constructor":{"prototype":true},"":false}}'
  const reordered = '{ "values":{"":false,"constructor":{"prototype":true},"__proto__":{"a":4,"z":3},"array":[{"a":1,"z":2},null],"nested":{"a":"","b":null},"a":1},"schemaVersion":1 }'
  const metadata = parseTaskMetadata(raw), other = parseTaskMetadata(reordered)
  const key = taskMetadataIntentKey(metadata)
  assert.equal(key, taskMetadataIntentKey(other))
  assert.equal(JSON.stringify(metadata), raw)
  assert.equal(JSON.stringify(other), JSON.stringify(JSON.parse(reordered)))
  assert.deepEqual(JSON.parse(key), metadata)
  assert.equal(Object.hasOwn(JSON.parse(key).values, '__proto__'), true)
  assert.deepEqual(JSON.parse(key).values.__proto__, { a: 4, z: 3 })
  for (const values of [
    { ...metadata.values, a: 2 },
    { ...metadata.values, array: [null, { z: 2, a: 1 }] },
    { ...metadata.values, nested: { b: '', a: '' } },
    { ...metadata.values, ['__proto__']: { a: 4, z: 5 } },
  ]) assert.notEqual(key, taskMetadataIntentKey({ schemaVersion: 1, values }))
  const removed = JSON.parse(raw); delete removed.values.__proto__
  assert.notEqual(key, taskMetadataIntentKey(removed))
})
