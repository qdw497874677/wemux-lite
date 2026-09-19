import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

/**
 * 密码哈希：带算法版本与参数的 scrypt，接受带盐、可升级。
 * 冻结策略见 `docs/design/account-identity-system.md` 第 5 节：
 * 无 MFA 时至少 15 字符，支持 64 字符以上长密码、粘贴与密码管理器，不强迫周期更换。
 * 存储格式 `scrypt$v1$N=<n>,r=<r>,p=<p>$<saltBase64>$<hashBase64>`：
 * 版本与参数必须随哈希保存，验证后按需升级，不假设固定参数。
 */
export const passwordHashAlgorithm = 'scrypt'
export const passwordHashVersion = 1

export const passwordPolicy = { minimumLength: 15, maximumLength: 200 } as const

export interface PasswordHashParameters {
  readonly N: number
  readonly r: number
  readonly p: number
}

/** 默认参数：128*N*r = 16 MiB 每哈希，node 默认 maxmem 32 MiB 之内。 */
export const defaultPasswordHashParameters: PasswordHashParameters = { N: 16384, r: 8, p: 1 }

/** 参数上限防止畸形或攻击者提供的哈希触发内存/CPU 耗尽。 */
const parameterBounds = { maximumN: 2 ** 17, maximumR: 32, maximumP: 16 } as const

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PasswordPolicyError'
  }
}

export function assertPasswordPolicy(password: string): void {
  if (typeof password !== 'string') throw new PasswordPolicyError('密码必须是字符串')
  if (password.length < passwordPolicy.minimumLength) throw new PasswordPolicyError(`密码至少需要 ${passwordPolicy.minimumLength} 个字符`)
  if (password.length > passwordPolicy.maximumLength) throw new PasswordPolicyError(`密码不能超过 ${passwordPolicy.maximumLength} 个字符`)
}

function assertSupportedParameters(parameters: PasswordHashParameters): void {
  const valid = Number.isSafeInteger(parameters.N) && parameters.N > 1 && (parameters.N & (parameters.N - 1)) === 0
    && Number.isSafeInteger(parameters.r) && parameters.r >= 1
    && Number.isSafeInteger(parameters.p) && parameters.p >= 1
  if (!valid || parameters.N > parameterBounds.maximumN || parameters.r > parameterBounds.maximumR || parameters.p > parameterBounds.maximumP) {
    throw new PasswordPolicyError('不支持的密码哈希参数')
  }
}

// 限制并发哈希，避免注册/登录流量耗尽内存与 CPU（设计第 5 节）。
const maximumConcurrentHashes = 4
let activeHashes = 0
const waiting: (() => void)[] = []

async function withHashSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeHashes >= maximumConcurrentHashes) await new Promise<void>(resolve => waiting.push(resolve))
  activeHashes++
  try { return await work() } finally {
    activeHashes--
    waiting.shift()?.()
  }
}

function derive(password: string, salt: Buffer, parameters: PasswordHashParameters): Promise<Buffer> {
  return withHashSlot(() => new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, 64, { N: parameters.N, r: parameters.r, p: parameters.p }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  }))
}

export async function hashPassword(password: string, parameters: PasswordHashParameters = defaultPasswordHashParameters): Promise<string> {
  assertPasswordPolicy(password)
  assertSupportedParameters(parameters)
  const salt = randomBytes(16)
  const key = await derive(password, salt, parameters)
  return `${passwordHashAlgorithm}$v${passwordHashVersion}$N=${parameters.N},r=${parameters.r},p=${parameters.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

const encodedPattern = /^scrypt\$v(\d+)\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/

export interface PasswordVerification {
  readonly ok: boolean
  /** 哈希使用了非当前参数，验证成功后应按当前参数重新哈希。 */
  readonly needsRehash: boolean
}

/** 未知算法/版本/畸形哈希一律失败，不降级信任。 */
export async function verifyPassword(password: string, encoded: string): Promise<PasswordVerification> {
  const match = typeof encoded === 'string' ? encodedPattern.exec(encoded) : null
  if (!match || password.length > passwordPolicy.maximumLength) return { ok: false, needsRehash: false }
  const parameters: PasswordHashParameters = { N: Number(match[2]), r: Number(match[3]), p: Number(match[4]) }
  let salt: Buffer, expected: Buffer
  try {
    assertSupportedParameters(parameters)
    salt = Buffer.from(match[5], 'base64')
    expected = Buffer.from(match[6], 'base64')
  } catch { return { ok: false, needsRehash: false } }
  if (salt.length < 16 || expected.length !== 64 || Number(match[1]) !== passwordHashVersion) return { ok: false, needsRehash: false }
  const actual = await derive(password, salt, parameters)
  const ok = actual.length === expected.length && timingSafeEqual(actual, expected)
  return {
    ok,
    needsRehash: ok && (parameters.N !== defaultPasswordHashParameters.N || parameters.r !== defaultPasswordHashParameters.r || parameters.p !== defaultPasswordHashParameters.p),
  }
}