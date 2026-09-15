import type { ConnectionConfig } from '../api/client'
import { randomId } from '../lib/random.ts'

export const connectionStorageKey = 'wemux.connection'
const empty = (): ConnectionConfig => ({ token: '', teamId: '' })

export function isConnectionExpired(config: ConnectionConfig, now = Date.now()): boolean {
  return config.expiresAt !== undefined && (!Number.isFinite(Date.parse(config.expiresAt)) || Date.parse(config.expiresAt) <= now)
}

export function readConnectionConfig(storage: Pick<Storage, 'getItem' | 'removeItem'> & Partial<Pick<Storage, 'setItem'>> = window.localStorage, now = Date.now()): ConnectionConfig {
  try {
    const raw = storage.getItem(connectionStorageKey)
    if (!raw) return empty()
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return empty()
    const { token, teamId, expiresAt, connectionId } = value as Record<string, unknown>
    const config = typeof token === 'string' && typeof teamId === 'string' && (expiresAt === undefined || typeof expiresAt === 'string')
      ? { token, teamId, ...(typeof connectionId === 'string' ? { connectionId } : {}), ...(typeof expiresAt === 'string' ? { expiresAt } : {}) }
      : empty()
    if (isConnectionExpired(config, now)) { storage.removeItem(connectionStorageKey); return empty() }
    if (config.token && !config.connectionId && storage.setItem) { config.connectionId = randomId(); storage.setItem(connectionStorageKey, JSON.stringify(config)) }
    return config
  } catch {
    return empty()
  }
}

export function saveConnectionConfig(config: ConnectionConfig, storage: Pick<Storage, 'setItem'> = window.localStorage): void {
  config.connectionId ??= randomId()
  storage.setItem(connectionStorageKey, JSON.stringify(config))
}

export function clearConnectionConfig(storage: Pick<Storage, 'removeItem'> = window.localStorage): void {
  storage.removeItem(connectionStorageKey)
}
