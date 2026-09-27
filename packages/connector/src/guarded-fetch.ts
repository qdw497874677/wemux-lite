// Derived from oomol-lab/open-connector (Apache-2.0).

import { lookup as nodeLookup } from 'node:dns/promises'
import { assertPublicHttpUrl, classifyIpAddress, isIpAddress, isIpv4Address } from './egress-address-policy.js'

export interface ResolvedAddress {
  readonly address: string
  readonly family: number
}

export type GuardedFetchDnsLookup = (hostname: string) => Promise<readonly ResolvedAddress[]>

export interface GuardedFetchOptions {
  readonly fetch?: typeof fetch
  readonly deploymentAllowsPrivateNetwork?: boolean | (() => boolean)
  readonly connectorAllowsPrivateNetwork?: boolean | (() => boolean)
  readonly createError?: (message: string) => Error
  readonly maxRedirects?: number
  readonly lookup?: GuardedFetchDnsLookup
  readonly additionalSensitiveHeaders?: readonly string[]
  readonly mapTransportError?: (error: unknown) => unknown
}

export const defaultMaxRedirects = 5
const redirectStatuses = new Set([301, 302, 303, 307, 308])
const bodyHeaders = ['content-encoding', 'content-language', 'content-length', 'content-location', 'content-type']

export const crossOriginSafeHeaders: ReadonlySet<string> = new Set([
  'accept',
  'accept-charset',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-length',
  'content-md5',
  'content-range',
  'content-type',
  'dnt',
  'idempotency-key',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'range',
  'user-agent',
  'x-correlation-id',
  'x-request-id',
  'x-trace',
])

export function createGuardedFetch(options: GuardedFetchOptions = {}): typeof fetch {
  const createError = options.createError ?? ((message: string) => new TypeError(message))
  const maxRedirects = options.maxRedirects ?? defaultMaxRedirects
  const baseFetch = options.fetch ?? globalThis.fetch

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined
    const privateNetworkAllowed = flag(options.deploymentAllowsPrivateNetwork) && flag(options.connectorAllowsPrivateNetwork)
    const guard = (value: string, fieldName: string) =>
      assertGuardedEgressUrl(value, {
        fieldName,
        createError,
        allowPrivateNetwork: privateNetworkAllowed,
        lookup: options.lookup ?? defaultDnsLookup,
      })
    const runFetch = async (fetchInput: RequestInfo | URL, fetchInit?: RequestInit): Promise<Response> => {
      try {
        return await baseFetch(fetchInput, fetchInit)
      } catch (error) {
        throw options.mapTransportError?.(error) ?? error
      }
    }

    let url = await guard(request?.url ?? (input instanceof URL ? input.href : String(input)), 'request URL')
    const redirectMode = init?.redirect ?? request?.redirect ?? 'follow'
    if (redirectMode !== 'follow') return runFetch(input, init)

    let method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers ?? request?.headers)
    let body: BodyInit | null | undefined = init?.body !== undefined ? init.body : request?.body

    for (let redirectCount = 0; ; redirectCount += 1) {
      const response = await runFetch(url, {
        ...init,
        method,
        headers: new Headers(headers),
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        redirect: 'manual',
        signal: init?.signal ?? request?.signal ?? null,
      })
      if (!redirectStatuses.has(response.status)) return response
      const location = response.headers.get('location')
      if (location === null) return response
      await cancelResponseBody(response)
      if (redirectCount >= maxRedirects) throw createError('request was redirected too many times')

      let next: URL
      try {
        next = new URL(location, url)
      } catch {
        throw createError('redirect location must be a valid URL')
      }
      const guardedNext = await guard(next.href, 'redirect location')
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
        for (const name of bodyHeaders) headers.delete(name)
      } else if (body !== undefined && body !== null && !isReplayableBody(body)) {
        throw createError('redirect cannot be followed because the request body is not replayable')
      }
      if (guardedNext.origin !== url.origin) {
        const explicitlySensitive = new Set(options.additionalSensitiveHeaders?.map((name) => name.toLowerCase()) ?? [])
        for (const name of [...headers.keys()]) {
          if (!crossOriginSafeHeaders.has(name) || explicitlySensitive.has(name)) headers.delete(name)
        }
      }
      url = guardedNext
    }
  }) as typeof fetch
}

export interface GuardedEgressUrlOptions {
  readonly fieldName: string
  readonly createError: (message: string) => Error
  readonly createResolutionError?: (message: string) => Error
  readonly allowPrivateNetwork?: boolean
  readonly lookup?: GuardedFetchDnsLookup
}

export async function assertGuardedEgressUrl(value: string, options: GuardedEgressUrlOptions): Promise<URL> {
  const url = assertPublicHttpUrl(value, options)
  await assertResolvedAddressesAllowed(url.hostname, options)
  return url
}

async function assertResolvedAddressesAllowed(hostname: string, options: GuardedEgressUrlOptions): Promise<void> {
  if (isIpv4Address(hostname) || isIpAddress(hostname)) return
  const resolutionError = options.createResolutionError ?? options.createError
  let addresses: readonly ResolvedAddress[]
  try {
    addresses = await (options.lookup ?? defaultDnsLookup)(hostname)
  } catch {
    throw resolutionError(`${options.fieldName} could not be resolved for validation`)
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw resolutionError(`${options.fieldName} could not be resolved for validation`)
  }
  for (const entry of addresses) {
    if (!entry || typeof entry.address !== 'string' || !isIpAddress(entry.address)) {
      throw resolutionError(`${options.fieldName} could not be resolved for validation`)
    }
    const classification = classifyIpAddress(entry.address)
    if (classification === 'always-blocked' || (classification === 'private' && !options.allowPrivateNetwork)) {
      throw options.createError(`${options.fieldName} must not resolve to private or reserved IP addresses`)
    }
  }
}

async function defaultDnsLookup(hostname: string): Promise<readonly ResolvedAddress[]> {
  const results = await nodeLookup(hostname, { all: true })
  const addresses = results.filter((entry) => isIpAddress(entry.address))
  if (addresses.length === 0) throw new Error(`${hostname} did not resolve to any IP address`)
  return addresses
}

function flag(value: boolean | (() => boolean) | undefined): boolean {
  return typeof value === 'function' ? value() : value === true
}

function isReplayableBody(body: BodyInit): boolean {
  return (
    typeof body === 'string' ||
    body instanceof URLSearchParams ||
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  )
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response is abandoned even when its body cannot be cancelled.
  }
}
