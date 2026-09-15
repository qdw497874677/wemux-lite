import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApi } from '../src/api/client.ts'
import { QueryClient } from '@tanstack/react-query'
test('401 disposes identity once and prevents new requests with stale credentials', async () => {
 const originalFetch = globalThis.fetch; const originalWindow = globalThis.window
 let requests = 0; let unauthorized = 0
 globalThis.window = { location: { origin: 'http://localhost' } }
 globalThis.fetch = async () => { requests++; return new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }) }
 try {
  const api = createApi({ token: 'expired', teamId: '' }, () => { unauthorized++ })
  await assert.rejects(api.projects()); await assert.rejects(api.projects())
  assert.equal(unauthorized, 1); assert.equal(requests, 1)
 } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow }
})
test('disposed Query scope cannot fill replacement identity cache with late metadata', async () => {
 const old = new QueryClient(); const next = new QueryClient(); let release
 const pending = old.fetchQuery({ queryKey: ['projects'], queryFn: () => new Promise(resolve => { release = resolve }) }).catch(() => {})
 await old.cancelQueries(); old.clear(); release([{ id: 'private-old' }]); await pending
 assert.equal(old.getQueryData(['projects']), undefined); assert.equal(next.getQueryData(['projects']), undefined)
 old.clear(); next.clear()
})

test('resource consumers share in-flight and fresh requests; next connection fetches independently', async () => {
 const { resourceOptions } = await import('../src/app/resources.ts')
 const { QueryObserver } = await import('@tanstack/react-query')
 let calls = 0; let release
 const api = { workers: () => { calls++; return new Promise(resolve => { release = resolve }) } }
 const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
 const options = resourceOptions(api).workers
 const observers = [new QueryObserver(client, options), new QueryObserver(client, options), new QueryObserver(client, options)]
 const unsubscribe = observers.map(observer => observer.subscribe(() => {}))
 assert.equal(calls, 1)
 release([]); await new Promise(resolve => setImmediate(resolve))
 const cached = new QueryObserver(client, options); const stop = cached.subscribe(() => {})
 assert.equal(calls, 1)
 unsubscribe.forEach(fn => fn()); stop(); await client.cancelQueries(); client.clear()
 const next = new QueryClient(); const request = next.fetchQuery(options)
 assert.equal(calls, 2); release([]); await request; next.clear()
})
