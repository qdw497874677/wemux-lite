// Bundled only by the local diagnostic fixture. No application bootstrap or identity is loaded.
import { createApi } from '../../web/src/api/client.ts'
import { QueryClient } from '@tanstack/react-query'

let counter = 0, documentSeq = 0
const report = (event, extra = {}) => {
  void window.fixtureEvent({ source: 'document', event, documentId: 'old-document', documentSeq: ++documentSeq, documentMs: performance.now(), ...extra })
}
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : input, location.href)
  if (url.origin !== location.origin) throw Error('Fixture forbids external fetch')
  const requestId = `fixture-${window.fixtureScenario}-${++counter}`
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.set('x-fixture-request-id', requestId)
  const signal = init.signal ?? (input instanceof Request ? input.signal : undefined)
  report('fetch-start', { requestId, path: url.pathname })
  signal?.addEventListener('abort', () => report('signal-abort', { requestId, reason: signal.reason?.name ?? 'unknown' }), { once: true })
  try {
    const response = await nativeFetch(input, { ...init, headers })
    report('fetch-response', { requestId, status: response.status })
    if (response.status === 401) report('unauthorized-response', { requestId })
    return response
  } catch (error) {
    report('fetch-rejected', { requestId, reason: error.name })
    throw error
  }
}
const config = { teamId: '', csrfToken: '' }
let api, stopProject, stopSession, client, controller
const consume = promise => void promise.catch(error => report('operation-rejected', { reason: error.name }))
window.fixture = {
  startStreams() {
    api = createApi(config, () => report('unauthorized-callback'))
    stopProject = api.watchProject('fixture-project', () => {}, () => {})
    stopSession = api.watch('fixture-session', 0, () => {}, () => {})
  },
  stopStreams() { report('unsubscribe'); stopProject(); stopSession() },
  startQueries() {
    api = createApi(config)
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    consume(client.fetchQuery({ queryKey: ['project', 'fixture-project', 'activity'], queryFn: ({ signal }) => api.projectActivity('fixture-project', 0, signal) }))
    consume(client.fetchQuery({ queryKey: ['project', 'fixture-project', 'tasks'], queryFn: ({ signal }) => api.tasks('fixture-project', signal) }))
  },
  routeCleanup() {
    // Synthetic route host; actual QueryClient cancellation and actual transport, not the product router/useProject hook.
    history.pushState({}, '', '/route-two')
    report('spa-route')
    report('query-cancel-call')
    void client.cancelQueries({ queryKey: ['project', 'fixture-project'] })
  },
  trigger401() { consume(api.events('fixture-session', 0)) },
  startRaw(path) {
    controller = new AbortController()
    consume(fetch(path, { signal: controller.signal }).then(response => response.text()))
  },
  abortRaw() { report('explicit-abort'); controller.abort() },
}
window.fixtureReady = true
