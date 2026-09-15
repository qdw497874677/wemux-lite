import assert from 'node:assert/strict'
import test from 'node:test'
import { clearConnectionConfig, connectionStorageKey, isConnectionExpired, readConnectionConfig, saveConnectionConfig } from '../src/lib/connection-storage.ts'

function memoryStorage(initial = new Map()) {
  return {
    getItem(key) { return initial.get(key) ?? null },
    setItem(key, value) { initial.set(key, value) },
    removeItem(key) { initial.delete(key) },
    values: initial,
  }
}

test('expiring access token is saved and survives reload before expiry', () => {
  const storage = memoryStorage()
  const config = { token: 'wemux-session-secret', teamId: 'team-1', expiresAt: '2030-01-01T00:00:00.000Z' }
  saveConnectionConfig(config, storage)
  assert.equal(storage.values.has(connectionStorageKey), true)
  assert.equal(isConnectionExpired(config, Date.parse('2029-12-31T23:59:59.000Z')), false)
  assert.deepEqual(readConnectionConfig(storage, Date.parse('2029-12-31T23:59:59.000Z')), config)
})

test('expired access token is removed and cannot be restored', () => {
  const storage = memoryStorage()
  saveConnectionConfig({ token: 'expired', teamId: 'team-1', expiresAt: '2025-01-01T00:00:00.000Z' }, storage)
  assert.deepEqual(readConnectionConfig(storage, Date.parse('2025-01-01T00:00:00.001Z')), { token: '', teamId: '' })
  assert.equal(storage.values.has(connectionStorageKey), false)
})

test('invalid stored config falls back and explicit clear removes it', () => {
  const storage = memoryStorage(new Map([[connectionStorageKey, '{bad']]))
  assert.deepEqual(readConnectionConfig(storage), { token: '', teamId: '' })
  saveConnectionConfig({ token: 'value', teamId: 'team-1' }, storage)
  clearConnectionConfig(storage)
  assert.equal(storage.values.has(connectionStorageKey), false)
})
