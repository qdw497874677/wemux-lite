import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPublicHttpUrl,
  classifyIpAddress,
  createGuardedFetch,
  isBlockedIpAddress,
  type GuardedFetchDnsLookup,
} from '../src/index.js'

const publicLookup: GuardedFetchDnsLookup = async () => [{ address: '93.184.216.34', family: 4 }]
const response = (status = 200, headers?: HeadersInit) => new Response(null, { status, headers })

test('URL literal validation accepts HTTP(S) and rejects unsafe syntax and userinfo', () => {
  assert.equal(assertPublicHttpUrl('https://example.com/path').hostname, 'example.com')
  assert.throws(() => assertPublicHttpUrl('file:///etc/passwd'), /http or https/)
  assert.throws(() => assertPublicHttpUrl('https://user:pass@example.com'), /userinfo/)
  assert.throws(() => assertPublicHttpUrl('http://localhost'), /local hosts/)
})

test('IPv4 and IPv6 classification blocks private and permanent ranges', () => {
  assert.equal(classifyIpAddress('8.8.8.8'), 'public')
  assert.equal(classifyIpAddress('10.0.0.1'), 'private')
  assert.equal(classifyIpAddress('fd12::1'), 'private')
  assert.equal(classifyIpAddress('::1'), 'always-blocked')
  assert.equal(isBlockedIpAddress('10.0.0.1'), true)
  assert.equal(isBlockedIpAddress('10.0.0.1', true), false)
  assert.equal(isBlockedIpAddress('169.254.169.254', true), true)
})

test('DNS answers are checked and lookup failures fail closed before transport', async () => {
  let calls = 0
  const transport = async () => { calls += 1; return response() }
  const privateDns = createGuardedFetch({ fetch: transport as typeof fetch, lookup: async () => [{ address: '192.168.1.2', family: 4 }] })
  await assert.rejects(privateDns('https://example.com'), /must not resolve/)
  const failedDns = createGuardedFetch({ fetch: transport as typeof fetch, lookup: async () => { throw new Error('dns down') } })
  await assert.rejects(failedDns('https://example.com'), /could not be resolved/)
  assert.equal(calls, 0)
})

test('private network access requires both deployment and connector switches', async () => {
  const combinations = [
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [true, true, true],
  ] as const
  for (const [deployment, connector, allowed] of combinations) {
    let calls = 0
    const guarded = createGuardedFetch({
      fetch: (async () => { calls += 1; return response() }) as typeof fetch,
      deploymentAllowsPrivateNetwork: deployment,
      connectorAllowsPrivateNetwork: connector,
      lookup: async () => [{ address: '10.1.2.3', family: 4 }],
    })
    if (allowed) await guarded('https://intranet.example')
    else await assert.rejects(guarded('https://intranet.example'), /must not resolve/)
    assert.equal(calls, allowed ? 1 : 0)
  }
})

test('metadata remains blocked with both private switches enabled', async () => {
  const guarded = createGuardedFetch({
    fetch: (async () => response()) as typeof fetch,
    deploymentAllowsPrivateNetwork: true,
    connectorAllowsPrivateNetwork: true,
    lookup: async () => [{ address: '169.254.169.254', family: 4 }],
  })
  await assert.rejects(guarded('https://metadata.example'), /must not resolve/)
  await assert.rejects(guarded('http://169.254.169.254/latest/meta-data'), /private or reserved/)
})

test('every redirect hop is revalidated', async () => {
  const seen: string[] = []
  const guarded = createGuardedFetch({
    lookup: async (hostname) => hostname === 'public.example'
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }],
    fetch: (async (input) => {
      seen.push(String(input))
      return response(302, { location: 'https://blocked.example/next' })
    }) as typeof fetch,
  })
  await assert.rejects(guarded('https://public.example/start'), /must not resolve/)
  assert.deepEqual(seen, ['https://public.example/start'])
})

test('cross-origin redirects strip authentication and custom headers', async () => {
  const calls: Array<{ url: string; headers: Headers }> = []
  const guarded = createGuardedFetch({
    lookup: publicLookup,
    fetch: (async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) })
      return calls.length === 1 ? response(302, { location: 'https://cdn.example/file' }) : response()
    }) as typeof fetch,
  })
  await guarded('https://api.example/file', { headers: { authorization: 'Bearer secret', 'x-api-key': 'secret', accept: 'application/json' } })
  assert.equal(calls[1]!.headers.has('authorization'), false)
  assert.equal(calls[1]!.headers.has('x-api-key'), false)
  assert.equal(calls[1]!.headers.get('accept'), 'application/json')
})

test('redirect count is bounded by the contract default', async () => {
  let calls = 0
  const guarded = createGuardedFetch({
    lookup: publicLookup,
    fetch: (async () => { calls += 1; return response(302, { location: `/hop-${calls}` }) }) as typeof fetch,
  })
  await assert.rejects(guarded('https://example.com/start'), /too many times/)
  assert.equal(calls, 6)
})
