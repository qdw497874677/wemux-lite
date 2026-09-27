// Derived from oomol-lab/open-connector (Apache-2.0).

export interface SafeSummaryProfile {
  readonly maxBytes: number
  readonly maxNodes: number
  readonly maxDepth: number
  readonly maxStringLength: number
  readonly maxArrayLength: number
  readonly maxObjectKeys: number
}

export const safeSummaryProfiles = {
  agentResult: {
    maxBytes: 256 * 1024,
    maxNodes: 100_000,
    maxDepth: 32,
    maxStringLength: 256 * 1024,
    maxArrayLength: 100_000,
    maxObjectKeys: 100_000,
  },
  journalSummary: {
    maxBytes: 16 * 1024,
    maxNodes: 256,
    maxDepth: 4,
    maxStringLength: 256,
    maxArrayLength: 20,
    maxObjectKeys: 50,
  },
} as const satisfies Record<string, SafeSummaryProfile>

export type SafeSummaryProfileName = keyof typeof safeSummaryProfiles

const sensitiveKeyPattern =
  /access[-_]?key|account[-_]?key|api[-_]?key|authorization|client[-_]?secret|cookie|credential|password|private[-_]?key|refresh[-_]?token|secret|session|signature|token/i
const sensitiveContextPattern = /(^|\.)(cookies?|credentials?|headers?|secrets?)(\.|$)/i
const credentialValuePattern = /^(?:Basic|Bearer)\s+\S+|^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i
const urlPattern = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i
const protocolRelativeBase = 'relative://summary.invalid'

interface SummaryState {
  nodes: number
}

export function safeSummary(value: unknown, profileName: SafeSummaryProfileName): unknown {
  const profile = safeSummaryProfiles[profileName]
  try {
    const summary = summarize(value, [], 0, { nodes: 0 }, profile)
    return new TextEncoder().encode(JSON.stringify(summary)).byteLength <= profile.maxBytes ? summary : '[truncated]'
  } catch {
    return '[unavailable]'
  }
}

export function summarizeAgentResult(value: unknown): unknown {
  return safeSummary(value, 'agentResult')
}

export function summarizeJournal(value: unknown): unknown {
  return safeSummary(value, 'journalSummary')
}

function summarize(
  value: unknown,
  path: readonly string[],
  depth: number,
  state: SummaryState,
  profile: SafeSummaryProfile,
): unknown {
  if (state.nodes >= profile.maxNodes || depth > profile.maxDepth) return '[truncated]'
  state.nodes += 1
  if (typeof value === 'string') return summarizeString(value, path, profile.maxStringLength)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[unavailable]'
  if (Array.isArray(value)) {
    return value.slice(0, profile.maxArrayLength).map((item) => summarize(item, path, depth + 1, state, profile))
  }
  if (typeof value === 'object') return summarizeObject(value, path, depth, state, profile)
  return '[unavailable]'
}

function summarizeObject(
  value: object,
  path: readonly string[],
  depth: number,
  state: SummaryState,
  profile: SafeSummaryProfile,
): unknown {
  try {
    const prototype = Object.getPrototypeOf(value)
    if (ArrayBuffer.isView(value) || (prototype !== Object.prototype && prototype !== null)) return '[unavailable]'
    const entries: [string, unknown][] = []
    for (const key of Object.keys(value)) {
      if (entries.length >= profile.maxObjectKeys || key === '__proto__' || key === 'constructor' || key === 'prototype') break
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable) continue
      const nextPath = [...path, key]
      if (sensitiveKeyPattern.test(key) || sensitiveContextPattern.test(nextPath.join('.'))) {
        entries.push([key, '[redacted]'])
      } else if ('value' in descriptor) {
        entries.push([key, summarize(descriptor.value, nextPath, depth + 1, state, profile)])
      } else {
        entries.push([key, '[unavailable]'])
      }
    }
    return Object.fromEntries(entries)
  } catch {
    return '[unavailable]'
  }
}

function summarizeString(value: string, path: readonly string[], maxLength: number): string {
  if (credentialValuePattern.test(value)) return '[redacted]'
  if (urlPattern.test(value)) {
    const summary = summarizeUrl(value, path)
    if (summary !== undefined) return summary
  }
  return value.length > maxLength ? `${value.slice(0, maxLength)}[truncated]` : value
}

function summarizeUrl(value: string, path: readonly string[]): string | undefined {
  const protocolRelative = value.startsWith('//')
  try {
    const url = new URL(value, protocolRelative ? protocolRelativeBase : undefined)
    if (url.username || url.password || [...url.searchParams.keys()].some((name) => sensitiveKeyPattern.test(name))) {
      return '[redacted-url]'
    }
    if (/callback|download|presigned|signed|temporary|webhook/i.test(path.join('.'))) return '[redacted-url]'
    if (protocolRelative) return `//${url.host}`
    return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin
  } catch {
    return hasUserinfo(value) || hasSensitiveQuery(value) ? '[redacted-url]' : undefined
  }
}

function hasUserinfo(value: string): boolean {
  const authorityStart = value.indexOf('://') + 3
  for (let index = authorityStart; index < value.length; index += 1) {
    const character = value[index]
    if (character === '@') return true
    if (character === '/' || character === '?' || character === '#') return false
  }
  return false
}

function hasSensitiveQuery(value: string): boolean {
  const queryStart = value.indexOf('?')
  if (queryStart === -1) return false
  return [...new URLSearchParams(value.slice(queryStart + 1)).keys()].some((name) => sensitiveKeyPattern.test(name))
}
