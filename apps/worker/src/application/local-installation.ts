import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Timestamp } from '@wemux/domain'
import type { LocalAdminRecord, LocalInstallationIdentity } from '../domain/local-installation.js'
import type { LocalState } from './ports/local-state.js'

const scrypt = promisify(scryptCallback)
const keyLength = 32

function timestamp(): Timestamp {
  return new Date().toISOString() as Timestamp
}

export function ensureLocalInstallation(state: LocalState, name: string): LocalInstallationIdentity {
  const current = state.localInstallation()
  if (current) return current
  const identity: LocalInstallationIdentity = {
    installationId: randomUUID(),
    name,
    createdAt: timestamp(),
  }
  state.saveLocalInstallation(identity)
  return identity
}

export async function createLocalAdmin(
  state: LocalState,
  input: { readonly username: string; readonly password: string },
): Promise<LocalAdminRecord> {
  if (state.localAdmin()) throw new Error('Local administrator is already initialized')
  const username = input.username.trim()
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) throw new Error('Username must be 1-64 letters, numbers, dot, underscore or hyphen')
  if (input.password.length < 12 || input.password.length > 1024) throw new Error('Password must contain 12-1024 characters')
  const passwordSalt = randomBytes(16).toString('base64url')
  const passwordHash = (await scrypt(input.password, passwordSalt, keyLength) as Buffer).toString('base64url')
  const record: LocalAdminRecord = { username, passwordSalt, passwordHash, createdAt: timestamp() }
  state.saveLocalAdmin(record)
  return record
}

export async function verifyLocalAdmin(
  record: LocalAdminRecord,
  input: { readonly username: string; readonly password: string },
): Promise<boolean> {
  const expected = Buffer.from(record.passwordHash, 'base64url')
  const actual = await scrypt(input.password, record.passwordSalt, expected.length) as Buffer
  return record.username === input.username && actual.length === expected.length && timingSafeEqual(actual, expected)
}
