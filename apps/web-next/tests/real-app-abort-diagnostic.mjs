// Local diagnostic only: actual legacy main.tsx/App, no product route substitutes.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { launchAcceptanceBrowser } from './acceptance-runtime.mjs'

const source = path => fileURLToPath(new URL(path, import.meta.url))
const historyPath = '/api/sessions/local-session/events'
const historyText = 'Local fixture historical assistant text'
const timestamp = '2026-01-01T00:00:00.000Z'
const history = { events: [{ sessionId: 'local-session', seq: 1, occurredAt: timestamp, payload: { kind: 'assistant.text.delta', turnId: 'local-turn', text: historyText } }], nextSeq: null, freshness: { status: 'synced' } }
const items = items => ({ items })
const fixtures = {
  '/api/host': { hostKind: 'cluster', contractVersion: 1, capabilities: [] },
  '/api/auth/me': { user: { id: 'local-user', username: 'Local fixture', email: null, createdAt: timestamp }, teamId: 'local-team', csrfToken: 'local-fixture-not-a-credential', instanceAdministrator: false, session: { id: 'local-login', current: true } },
  '/api/projects': items([{ id: 'local-project', teamId: 'local-team', ownerId: 'local-user', name: 'Local diagnostic project', shareScope: 'owner-only', accessRole: 'viewer' }]),
  '/api/workers': items([]),
  '/api/workspaces': items([{ id: 'local-workspace', projectId: 'local-project', name: 'Local workspace', workerId: 'local-worker', status: 'ready', placements: [], location: null }]),
  '/api/sessions': items([{ id: 'local-session', projectId: 'local-project', ownerId: 'local-user', workspaceId: 'local-workspace', title: 'Local history session', runtimeState: 'idle', binding: { agent: { workerId: 'local-worker', agentKey: 'fixture' }, modelId: null }, access: { canRead: true, canWrite: false, canControl: false, projectRole: 'viewer' }, sendCapability: { allowed: false, reason: 'Read-only diagnostic' } }]),
  '/api/attention': { items: [], total: 0 },
  '/api/projects/local-project/tasks': items([]),
  '/api/projects/local-project/reviews': items([]),
  '/api/projects/local-project/activity': items([]),
}

export async function runRealAppAbortDiagnostic({ evidence = '/tmp/wemux-real-app-abort', releaseBeforeNavigation = false, assertNoAbort = false } = {}) {
  const result = { actualAppMounted: false, releaseBeforeNavigation, assertNoAbort, passed: false, events: [], violations: [], sourceHashes: {} }
  let server, browser, sequence = 0, armed = false, held
  const record = event => result.events.push({ sequence: ++sequence, ...event })
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 12000
    while (!predicate()) { if (Date.now() > deadline) throw Error(`Barrier timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)) }
  }
  const has = (id, source, event) => result.events.some(e => e.id === id && e.source === source && e.event === event)
  await mkdir(evidence, { recursive: true })
  try {
    // Bundle the real entry (including StrictMode), not a replacement router or hook harness.
    // CSS is omitted: this is a lifecycle diagnostic, not visual acceptance.
    // Keep metafile input paths stable for both root and workspace test entry points.
    const bundle = await build({ absWorkingDir: source('../../../'), entryPoints: [source('../../web/src/main.tsx')], bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@': source('../../web/src'), '@wemux/web-client': source('../../../packages/web-client/src/index.ts') }, metafile: true })
    assert.ok(Object.keys(bundle.metafile.inputs).some(path => path.endsWith('apps/web/src/App.tsx')))
    for (const path of ['../../web/src/main.tsx', '../../web/src/App.tsx', '../../web/src/app/router.tsx', '../../web/src/api/use-session.ts', '../../web/src/api/client.ts', '../../../packages/web-client/src/cluster-transport.ts']) result.sourceHashes[path] = createHash('sha256').update(await readFile(source(path))).digest('hex')
    const favicon = await readFile(source('../../web/public/favicon.svg'))
    server = createServer((request, response) => {
      const path = new URL(request.url, 'http://local.invalid').pathname
      const id = request.headers['x-local-diagnostic-id'] ?? (path === '/favicon.svg' ? 'favicon' : undefined)
      if (id) {
        record({ source: 'server', event: 'received', id, path, method: request.method })
        response.on('finish', () => record({ source: 'server', event: 'finished', id }))
        response.on('close', () => record({ source: 'server', event: 'closed', id, ended: response.writableEnded, headersSent: response.headersSent }))
      }
      const send = (body, contentType = 'application/json') => { record({ source: 'server', event: 'response', id, status: 200 }); response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' }).end(contentType === 'application/json' ? JSON.stringify(body) : body) }
      if (request.method !== 'GET') { result.violations.push(`non-GET ${path}`); response.writeHead(405).end(); return }
      if (path === '/app.js') { send(bundle.outputFiles[0].text, 'text/javascript'); return }
      if (path === '/favicon.svg') { send(favicon, 'image/svg+xml'); return }
      if (path === '/projects/local-project/sessions/local-session' || path === '/projects') { send('<!doctype html><link rel="icon" href="/favicon.svg"><div id="root"></div><script src="/app.js"></script>', 'text/html'); return }
      if (path === historyPath) {
        if (armed) { held = { id, response, release: () => send(history) }; record({ source: 'server', event: 'gate-held', id }); return }
        send(history); return
      }
      if (path === '/api/projects/local-project/events' || path === '/api/sessions/local-session/stream') { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': fixture connected\n\n'); return }
      if (Object.hasOwn(fixtures, path)) { send(fixtures[path]); return }
      result.violations.push(`unknown GET ${path}`); response.writeHead(404).end()
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const origin = `http://127.0.0.1:${server.address().port}`
    browser = await launchAcceptanceBrowser()
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin || route.request().method() !== 'GET') { result.violations.push('blocked external or write request'); return route.abort('blockedbyclient') }
      return route.continue()
    })
    const page = await context.newPage()
    page.setDefaultTimeout(12000)
    await page.exposeFunction('localDiagnosticEvent', event => record({ source: 'document', ...event }))
    await page.addInitScript(() => {
      let count = 0
      const emit = event => { void window.localDiagnosticEvent({ ...event, path: location.pathname, documentTime: performance.now() }) }
      emit({ event: 'document-start' })
      addEventListener('pagehide', () => emit({ event: 'pagehide' }))
      const original = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        const id = `read-${++count}`, signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        headers.set('x-local-diagnostic-id', id)
        emit({ event: 'fetch-start', id, url: String(input), hasSignal: Boolean(signal), alreadyAborted: signal?.aborted ?? false })
        signal?.addEventListener('abort', () => emit({ event: 'signal-abort', id, reason: signal.reason?.name }), { once: true })
        try { const response = await original(input, { ...init, headers }); emit({ event: 'fetch-response', id, status: response.status }); return response }
        catch (error) { emit({ event: 'fetch-rejected', id, reason: error.name, signalAborted: signal?.aborted ?? false }); throw error }
      }
    })
    const identities = new WeakMap(), statuses = new WeakMap()
    let browserId = 0, documents = 0
    const idFor = request => request.headers()['x-local-diagnostic-id'] ?? (new URL(request.url()).pathname === '/favicon.svg' ? 'favicon' : undefined)
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) record({ source: 'browser', event: 'frame-navigation', path: new URL(frame.url()).pathname }) })
    page.on('pageerror', error => result.violations.push(`pageerror: ${error.message}`))
    page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++; identities.set(request, ++browserId); if (idFor(request)) record({ source: 'browser', event: 'request', id: idFor(request), browserId, resourceType: request.resourceType() }) })
    page.on('response', response => { const request = response.request(); statuses.set(request, response.status()); if (idFor(request)) record({ source: 'browser', event: 'response', id: idFor(request), browserId: identities.get(request), status: response.status(), contentType: response.headers()['content-type'] }) })
    for (const [name, event] of [['requestfinished', 'finished'], ['requestfailed', 'failed']]) page.on(name, request => { if (idFor(request)) record({ source: 'browser', event, id: idFor(request), browserId: identities.get(request), status: statuses.get(request) ?? null, reason: request.failure()?.errorText ?? null }) })
    await page.goto(origin + '/projects/local-project/sessions/local-session')
    await page.getByText(historyText, { exact: true }).waitFor()
    await page.locator('[data-session-surface="local-session"]').waitFor()
    result.actualAppMounted = true
    await wait(() => has('favicon', 'server', 'finished') && has('favicon', 'browser', 'response') && has('favicon', 'browser', 'finished'), 'native favicon response and finish')
    // Keep native icon observations distinct from this explicit browser fetch.
    // Only the fetch has a document AbortSignal lifecycle; neither is a waiver.
    await page.evaluate(async () => { const response = await fetch('/favicon.svg'); await response.text() })
    const faviconId = result.events.find(e => e.source === 'document' && e.event === 'fetch-start' && e.url === '/favicon.svg').id
    await wait(() => has(faviconId, 'browser', 'finished'), 'favicon browser finish')
    result.faviconId = faviconId
    armed = true
    record({ source: 'driver', event: 'refresh-click' })
    await page.getByRole('button', { name: '刷新当前数据', exact: true }).click()
    await wait(() => held, 'history request received and gated')
    const target = held.id
    result.target = target
    await wait(() => has(target, 'browser', 'request') && has(target, 'document', 'fetch-start'), 'history identity joined')
    if (releaseBeforeNavigation) {
      record({ source: 'driver', event: 'release-before-navigation', id: target }); held.release()
      await wait(() => has(target, 'browser', 'finished'), 'control read finished')
      await page.getByText(historyText, { exact: true }).waitFor()
    }
    record({ source: 'driver', event: 'route-click', id: target })
    await page.locator('nav[aria-label="全局导航"] a[href="/projects"]').click()
    await page.waitForURL(origin + '/projects')
    await page.locator('[data-session-surface="local-session"]').waitFor({ state: 'detached' })
    await wait(() => has(target, 'document', 'signal-abort') && has(target, 'server', 'closed'), 'real session cleanup')
    if (!releaseBeforeNavigation) await wait(() => has(target, 'browser', 'failed'), 'browser abort')
    assert.equal(documents, 1, 'real SPA route must not replace document')
    assert.equal(result.events.filter(e => e.event === 'document-start').length, 1)
    assert.equal(result.events.some(e => e.event === 'pagehide'), false)
    assert.deepEqual(result.violations, [])
    const failure = result.events.find(e => e.id === target && e.source === 'browser' && e.event === 'failed')
    const close = result.events.find(e => e.id === target && e.source === 'server' && e.event === 'closed')
    if (!releaseBeforeNavigation) {
      assert.equal(failure?.reason, 'net::ERR_ABORTED')
      assert.equal(failure?.status, null, 'read was held before headers')
      assert.equal(close.ended, false)
      assert.equal(close.headersSent, false)
    } else { assert.equal(failure, undefined); assert.equal(close.ended, true) }
    if (assertNoAbort) assert.equal(failure, undefined, 'RED: real App route cleanup produced net::ERR_ABORTED on gated history GET')
    result.passed = true
  } catch (error) { result.error = error.message; throw error }
  finally {
    try { await browser?.close() } finally {
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
      await writeFile(`${evidence}/result.json`, JSON.stringify(result, null, 2))
    }
  }
  return result
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runRealAppAbortDiagnostic({ evidence: process.env.WEMUX_REAL_APP_EVIDENCE, releaseBeforeNavigation: process.argv.includes('--release-before-navigation'), assertNoAbort: process.argv.includes('--assert-no-abort') }).then(result => console.log(JSON.stringify({ passed: result.passed, actualAppMounted: result.actualAppMounted, target: result.target })), error => { console.error(error.message); process.exitCode = 1 })
}
