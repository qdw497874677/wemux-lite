// Synthetic HTTP fixture, not Server/Worker/runtime acceptance. No credential or database access.
// Run with PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node --test <this file>.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const modulePath = process.env.PLAYWRIGHT_MODULE

test('Chromium native fetch exercises shared conversation history/send/SSE reconnect and identity disposal', { skip: !modulePath }, async () => {
  const { chromium } = await import(modulePath)
  const calls = [], sockets = new Set(), stamp = '2026-06-01T00:00:00.000Z'
  let streamRequests = 0
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture')
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Conversation transport fixture</title>'); return }
    if (/^\/modules\/[a-z-]+\.js$/.test(url.pathname)) {
      res.setHeader('Content-Type', 'text/javascript')
      res.end(await readFile(new URL(`../dist/${url.pathname.split('/').at(-1)}`, import.meta.url))); return
    }
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), csrf: req.headers['x-csrf-token'], method: req.method })
    if (url.pathname === '/api/sessions/s/messages') {
      let raw = ''; for await (const chunk of req) raw += chunk
      calls.at(-1).body = JSON.parse(raw)
      res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ commandId: 'c', messageId: 'm', status: 'accepted' })); return
    }
    if (url.pathname === '/api/sessions/s/events') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ events: [{ sessionId: 's', seq: 1, occurredAt: stamp, payload: { kind: 'assistant.text.delta', text: '你好' } }], nextSeq: null, freshness: { sessionId: 's', contiguousSeq: 1, workerLastSeq: 1, status: 'synced' } })); return
    }
    if (url.pathname === '/api/sessions/s/stream') {
      streamRequests++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders()
      const bytes = Buffer.from('id: 999999\r\nevent: session.event\r\ndata: 你好\r\n\r\n')
      const split = bytes.indexOf(Buffer.from('你')) + 1
      res.write(bytes.subarray(0, split))
      setTimeout(() => { if (!res.destroyed) { res.write(bytes.subarray(split)); if (streamRequests === 1) res.end() } }, 10)
      return
    }
    const status = url.pathname.endsWith('/expired/stream') ? 401 : 403
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'fixture_permission', message: 'fixture denied' } }))
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    const result = await page.evaluate(async () => {
      const { createClusterClient } = await import('/modules/index.js')
      const identity = { username: 'fixture', teamId: 'team', csrfToken: 'fixture-csrf', email: null, instanceAdministrator: false }
      const api = createClusterClient(identity)
      let count = 0, watch
      const observed = new Promise(resolve => {
        watch = api.watchSession('s', { fromSeq: () => 1, maxReconnects: 1, reconnectDelayMs: 10, onInvalidate: () => { if (++count === 2) resolve() } })
      })
      const send = await api.sendMessage('s', { commandId: 'c', messageId: 'm', content: '  exact 你好\n' })
      const history = await api.sessionHistory('s')
      await Promise.race([observed, watch.done, new Promise((_, reject) => setTimeout(() => reject(Error('stream timeout')), 5000))])
      api.dispose(); await watch.done
      const stable = count
      await new Promise(resolve => setTimeout(resolve, 30))
      const next = createClusterClient({ ...identity, username: 'next', teamId: 'next-team' })
      let forbidden
      try { await next.watchSession('denied', { fromSeq: () => 1, onInvalidate: () => {} }).done } catch (e) { forbidden = { status: e.status, code: e.code } }
      let invalidated = 0, expired
      const expiry = createClusterClient(identity, () => invalidated++)
      try { await expiry.watchSession('expired', { fromSeq: () => 1, onInvalidate: () => {} }).done } catch (e) { expired = e.status }
      next.dispose(); expiry.dispose()
      return { send, history, count, stable, forbidden, expired, invalidated }
    })
    assert.equal(result.send.status, 'accepted'); assert.equal(result.history.events[0].payload.text, '你好')
    assert.equal(result.count, 2); assert.equal(result.stable, 2)
    assert.deepEqual(result.forbidden, { status: 403, code: 'fixture_permission' })
    assert.equal(result.expired, 401); assert.equal(result.invalidated, 1)
    assert.deepEqual(calls.filter(c => c.path === '/api/sessions/s/stream').map(c => c.query.fromSeq), ['1', '1'])
    assert.deepEqual(calls.find(c => c.method === 'POST').body, { commandId: 'c', messageId: 'm', content: '  exact 你好\n' })
    assert.equal(calls.find(c => c.method === 'POST').csrf, 'fixture-csrf')
    assert.equal(calls.find(c => c.path.endsWith('/denied/stream')).query.teamId, 'next-team')
    console.log(`Chromium ${browser.version()}; synthetic native-fetch/SSE assertions passed`)
  } finally {
    await browser?.close()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
})
