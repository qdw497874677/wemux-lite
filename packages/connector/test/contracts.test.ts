import assert from 'node:assert/strict'
import test from 'node:test'
import { connectorExecutionErrorCodes, stableFingerprint, type ConnectorDefinition, type ExecutionResult } from '../src/index.js'

test('contract unions are usable and execution error codes stay finite', () => {
  const definition = {
    kind: 'http',
    config: {
      baseUrl: 'https://example.com',
      allowedOperations: [],
      authentication: 'none',
      publicHeaders: {},
      allowPrivateNetwork: false,
    },
  } as unknown as ConnectorDefinition
  const result: ExecutionResult<string> = {
    ok: true,
    output: 'ok',
    requestId: 'request-1',
    connectorRevision: 1,
    completedAt: '2026-01-01T00:00:00.000Z' as never,
  }
  assert.equal(definition.kind, 'http')
  assert.equal(result.ok, true)
  assert.equal(connectorExecutionErrorCodes.length, 16)
})

test('stableFingerprint ignores object key insertion order and preserves semantic changes', () => {
  const left = stableFingerprint({ z: [3, { b: 2, a: 1 }], a: true })
  const right = stableFingerprint({ a: true, z: [3, { a: 1, b: 2 }] })
  assert.equal(left, right)
  assert.match(left, /^[0-9a-f]{64}$/u)
  assert.notEqual(left, stableFingerprint({ a: true, z: [3, { a: 1, b: 3 }] }))
  assert.throws(() => stableFingerprint({ value: Number.NaN }), /finite numbers/)
})
