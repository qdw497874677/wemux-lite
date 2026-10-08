// Diagnostic-only observer. Never changes the abort classifier or records URLs,
// headers, bodies, cookies, stack traces, or arbitrary exception/reason text.
export function acceptanceRequestKind(path) {
  if (['/api/auth/me', '/api/projects', '/api/workers', '/api/workspaces', '/api/sessions', '/api/attention'].includes(path)) return path.slice(5)
  const project = /^\/api\/projects\/[^/]+\/(activity|reviews|tasks|events)$/.exec(path)
  if (project) return `project-${project[1]}`
  if (/^\/api\/projects\/[^/]+\/tasks\/[^/]+$/.test(path)) return 'task'
  const session = /^\/api\/sessions\/[^/]+(?:\/(events|stream))?$/.exec(path)
  if (session) return `session-${session[1] ?? 'detail'}`
  return 'other'
}

// Serialized by Playwright; intentionally self-contained. Local fetch IDs are
// scoped to performance.timeOrigin (one document), not navigation intent epochs.
export function installFetchLifecycle() {
  let sequence = 0, requestId = 0, routeRevision = 0
  const emit = fields => {
    void window.__acceptanceFetchLifecycle({ document: performance.timeOrigin, sequence: ++sequence, at: performance.now(), routeRevision, ...fields }).catch(() => {})
  }
  emit({ event: 'document-start' })
  window.addEventListener('pagehide', () => emit({ event: 'pagehide' }))
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method]
    history[method] = function (...args) {
      const previous = location.pathname
      const result = Reflect.apply(original, this, args)
      if (location.pathname !== previous) { routeRevision++; emit({ event: 'spa-route', method }) }
      return result
    }
  }
  window.addEventListener('popstate', () => { routeRevision++; emit({ event: 'spa-route', method: 'popstate' }) })
  const original = window.fetch
  window.fetch = function (input, init) {
    const id = ++requestId
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    // Only pass the pathname to the binding in memory for immediate templating.
    // No query parameters or request data leave the document.
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    emit({ event: 'fetch-start', requestId: id, path: url.origin === location.origin ? url.pathname : '', method, hasSignal: Boolean(signal), alreadyAborted: signal?.aborted === true })
    const abort = () => emit({ event: 'signal-abort', requestId: id, reason: signal.reason?.name === 'AbortError' ? 'AbortError' : signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'other' })
    signal?.addEventListener('abort', abort, { once: true })
    // Keep observing after response headers: SSE and JSON body reads can still
    // be aborted after fetch resolves. This observer does not consume the body.
    return Reflect.apply(original, this, [input, init]).then(response => {
      emit({ event: 'fetch-response', requestId: id, status: response.status, stream: /^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') ?? '') })
      return response
    }, error => {
      emit({ event: 'fetch-rejected', requestId: id, signalAborted: signal?.aborted === true, reason: error?.name === 'AbortError' ? 'AbortError' : error?.name === 'TimeoutError' ? 'TimeoutError' : 'other' })
      throw error
    })
  }
}

export async function observeFetchLifecycle(page, trace) {
  const documents = new Map()
  await page.exposeBinding('__acceptanceFetchLifecycle', (_source, record) => {
    if (!documents.has(record.document)) documents.set(record.document, documents.size + 1)
    const { document, path, ...fields } = record
    trace({ ...fields, documentId: documents.get(document), ...(path === undefined ? {} : { requestKind: acceptanceRequestKind(path) }) })
  })
  await page.addInitScript(installFetchLifecycle)
}
