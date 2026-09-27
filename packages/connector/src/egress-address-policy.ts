// Derived from oomol-lab/open-connector (Apache-2.0).

const localHostnames = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'])
const metadataHostnames = new Set(['instance-data.ec2.internal', 'metadata', 'metadata.google.internal', 'metadata.goog'])
const localSuffixes = ['.localhost', '.localdomain']
const privateSuffixes = ['.local', '.internal', '.home', '.lan']

const privateIpv4Cidrs: readonly [number, number][] = [
  [ipv4ToNumber('10.0.0.0'), 8],
  [ipv4ToNumber('100.64.0.0'), 10],
  [ipv4ToNumber('172.16.0.0'), 12],
  [ipv4ToNumber('192.168.0.0'), 16],
]

const blockedIpv4Cidrs: readonly [number, number][] = [
  [ipv4ToNumber('0.0.0.0'), 8],
  [ipv4ToNumber('100.100.100.200'), 32],
  [ipv4ToNumber('127.0.0.0'), 8],
  [ipv4ToNumber('169.254.0.0'), 16],
  [ipv4ToNumber('192.0.0.0'), 24],
  [ipv4ToNumber('192.0.2.0'), 24],
  [ipv4ToNumber('198.18.0.0'), 15],
  [ipv4ToNumber('198.51.100.0'), 24],
  [ipv4ToNumber('203.0.113.0'), 24],
  [ipv4ToNumber('224.0.0.0'), 4],
  [ipv4ToNumber('240.0.0.0'), 4],
]

const blockedIpv6Cidrs: readonly [Uint8Array, number][] = [
  [ipv6ToBytes('::'), 128],
  [ipv6ToBytes('::1'), 128],
  [ipv6ToBytes('100::'), 64],
  [ipv6ToBytes('100:0:0:1::'), 64],
  [ipv6ToBytes('64:ff9b:1::'), 48],
  [ipv6ToBytes('2001:2::'), 48],
  [ipv6ToBytes('2001:db8::'), 32],
  [ipv6ToBytes('3fff::'), 20],
  [ipv6ToBytes('5f00::'), 16],
  [ipv6ToBytes('fd00:ec2::254'), 128],
  [ipv6ToBytes('fe80::'), 10],
  [ipv6ToBytes('ff00::'), 8],
]

const privateIpv6Cidrs: readonly [Uint8Array, number][] = [
  [ipv6ToBytes('fc00::'), 7],
  [ipv6ToBytes('fec0::'), 10],
]

const embeddedIpv4Cidrs: readonly [Uint8Array, number, number][] = [
  [ipv6ToBytes('::ffff:0:0'), 96, 12],
  [ipv6ToBytes('64:ff9b::'), 96, 12],
  [ipv6ToBytes('2002::'), 16, 2],
]

export type IpAddressClass = 'public' | 'private' | 'always-blocked'

export interface PublicHttpUrlOptions {
  readonly fieldName?: string
  readonly allowPrivateNetwork?: boolean
  readonly createError?: (message: string) => Error
}

export function parsePrivateNetworkAccessFlag(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function assertPublicHttpUrl(value: string, options: PublicHttpUrlOptions = {}): URL {
  const fieldName = options.fieldName ?? 'URL'
  const createError = options.createError ?? ((message: string) => new TypeError(message))
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw createError(`${fieldName} must be a valid URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw createError(`${fieldName} must use http or https`)
  }
  if (url.username !== '' || url.password !== '') {
    throw createError(`${fieldName} must not contain userinfo`)
  }

  const hostname = normalizeHostname(url.hostname)
  if (metadataHostnames.has(hostname)) throw createError(`${fieldName} must not target cloud metadata hosts`)
  if (localHostnames.has(hostname) || localSuffixes.some((suffix) => hostname.endsWith(suffix))) {
    throw createError(`${fieldName} must not target local hosts`)
  }
  if (!options.allowPrivateNetwork && privateSuffixes.some((suffix) => hostname.endsWith(suffix))) {
    throw createError(`${fieldName} must not target private hosts`)
  }
  if (isIpAddress(hostname) && isBlockedIpAddress(hostname, options.allowPrivateNetwork === true)) {
    throw createError(`${fieldName} must not target private or reserved IP addresses`)
  }
  if (hostname !== normalizeHostname(url.hostname)) url.hostname = hostname
  return url
}

export function classifyIpAddress(address: string): IpAddressClass {
  const ipv4 = parseIpv4(address)
  if (ipv4 !== undefined) return classifyIpv4(ipv4)
  const ipv6 = parseIpv6(address)
  if (ipv6 === undefined) return 'always-blocked'
  if (blockedIpv6Cidrs.some(([network, bits]) => ipv6InCidr(ipv6, network, bits))) return 'always-blocked'
  if (privateIpv6Cidrs.some(([network, bits]) => ipv6InCidr(ipv6, network, bits))) return 'private'
  for (const [network, bits, offset] of embeddedIpv4Cidrs) {
    if (ipv6InCidr(ipv6, network, bits)) return classifyIpv4(readIpv4At(ipv6, offset))
  }
  const teredo = classifyTeredo(ipv6)
  return teredo ?? 'public'
}

export function isBlockedIpAddress(address: string, allowPrivateNetwork = false): boolean {
  const classification = classifyIpAddress(address)
  return classification === 'always-blocked' || (classification === 'private' && !allowPrivateNetwork)
}

export function isIpAddress(value: string): boolean {
  return parseIpv4(value) !== undefined || parseIpv6(value) !== undefined
}

export function isIpv4Address(value: string): boolean {
  return parseIpv4(value) !== undefined
}

function classifyIpv4(value: number): IpAddressClass {
  if (blockedIpv4Cidrs.some(([network, bits]) => ipv4InCidr(value, network, bits))) return 'always-blocked'
  if (privateIpv4Cidrs.some(([network, bits]) => ipv4InCidr(value, network, bits))) return 'private'
  return 'public'
}

function classifyTeredo(value: Uint8Array): IpAddressClass | undefined {
  if (value[0] !== 0x20 || value[1] !== 0x01 || value[2] !== 0 || value[3] !== 0) return undefined
  const server = classifyIpv4(readIpv4At(value, 4))
  const client = classifyIpv4(readIpv4At(value, 12) ^ 0xffffffff)
  return server === 'always-blocked' || client === 'always-blocked'
    ? 'always-blocked'
    : server === 'private' || client === 'private'
      ? 'private'
      : 'public'
}

function normalizeHostname(value: string): string {
  let hostname = value.toLowerCase()
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1)
  while (hostname.endsWith('.')) hostname = hostname.slice(0, -1)
  return hostname
}

function parseIpv4(value: string): number | undefined {
  const parts = value.split('.')
  if (parts.length !== 4) return undefined
  let result = 0
  for (const part of parts) {
    if (!/^\d+$/u.test(part)) return undefined
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined
    result = (result << 8) + octet
  }
  return result >>> 0
}

function parseIpv6(value: string): Uint8Array | undefined {
  let input = normalizeHostname(value)
  const zone = input.indexOf('%')
  if (zone !== -1) input = input.slice(0, zone)
  if (!input.includes(':')) return undefined
  let head = input
  let tail = ''
  const compressed = input.indexOf('::')
  if (compressed !== -1) {
    if (input.includes('::', compressed + 1)) return undefined
    head = input.slice(0, compressed)
    tail = input.slice(compressed + 2)
  }
  const headWords = parseIpv6Words(head)
  const tailWords = parseIpv6Words(tail)
  if (!headWords || !tailWords) return undefined
  const missing = 8 - headWords.length - tailWords.length
  if (compressed === -1 ? headWords.length !== 8 : missing < 1) return undefined
  const words = compressed === -1 ? headWords : [...headWords, ...Array<number>(missing).fill(0), ...tailWords]
  const bytes = new Uint8Array(16)
  for (const [index, word] of words.entries()) {
    bytes[index * 2] = word >>> 8
    bytes[index * 2 + 1] = word & 0xff
  }
  return bytes
}

function parseIpv6Words(value: string): number[] | undefined {
  if (value === '') return []
  const words: number[] = []
  const parts = value.split(':')
  for (const [index, part] of parts.entries()) {
    if (part.includes('.')) {
      if (index !== parts.length - 1) return undefined
      const ipv4 = parseIpv4(part)
      if (ipv4 === undefined) return undefined
      words.push(ipv4 >>> 16, ipv4 & 0xffff)
    } else {
      if (!/^[0-9a-f]{1,4}$/u.test(part)) return undefined
      words.push(Number.parseInt(part, 16))
    }
  }
  return words
}

function ipv4ToNumber(value: string): number {
  const parsed = parseIpv4(value)
  if (parsed === undefined) throw new Error(`invalid IPv4 CIDR base: ${value}`)
  return parsed
}

function ipv6ToBytes(value: string): Uint8Array {
  const parsed = parseIpv6(value)
  if (!parsed) throw new Error(`invalid IPv6 CIDR base: ${value}`)
  return parsed
}

function ipv4InCidr(value: number, network: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (value & mask) === (network & mask)
}

function ipv6InCidr(value: Uint8Array, network: Uint8Array, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8)
  for (let index = 0; index < fullBytes; index++) if (value[index] !== network[index]) return false
  const remainder = bits % 8
  if (remainder === 0) return true
  const mask = (0xff << (8 - remainder)) & 0xff
  return (value[fullBytes]! & mask) === (network[fullBytes]! & mask)
}

function readIpv4At(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
}
