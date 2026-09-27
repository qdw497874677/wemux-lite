import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const files = [
  resolve(import.meta.dirname, '../../../../packages/wire-protocol/src/index.ts'),
  resolve(import.meta.dirname, '../../../../packages/wire-protocol/test/connector-contract.test.mjs'),
  resolve(import.meta.dirname, '../../../../packages/web-contract/src/connectors.ts'),
  resolve(import.meta.dirname, '../application/connector-service.ts'),
  resolve(import.meta.dirname, '../http/routes/connector-routes.ts'),
]
const forbidden = [/apiKey/i, /appSecret/i, /authorization/i, /ciphertext/i]
for (const file of files) test(`connector public surfaces contain no secret field names: ${file}`, () => {
  assert.equal(statSync(file).isFile(), true)
  const source = readFileSync(file, 'utf8')
  for (const pattern of forbidden) assert.doesNotMatch(source, pattern)
})
