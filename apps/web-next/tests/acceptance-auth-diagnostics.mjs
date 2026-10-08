// ConsoleMessage has no request/response identity. Neither its text, location nor
// args prove that a particular HTTP response caused it, so no console exception.
export function observeAcceptanceAuthDiagnostics(page, { base, getIdentity, report }) {
  const started = new WeakMap()
  // The caller replaces (never mutates) the identity at each lifecycle boundary.
  // A response must belong to a request that started in that same lifecycle.
  const identityFor = request => {
    const identity = started.get(request)
    return identity && identity === getIdentity() ? identity : undefined
  }
  page.on('request', request => started.set(request, getIdentity()))
  page.on('console', message => {
    if (message.type() === 'error') report({ type: 'console', expected: false })
  })
  page.on('response', response => {
    // HTTP errors can finish normally: requestfailed is not an HTTP status gate.
    if (response.status() !== 401) return
    const request = response.request()
    const url = new URL(request.url())
    const identity = identityFor(request)
    const requestKind = url.pathname === '/api/auth/me' ? 'auth-me' : url.pathname === '/api/projects' ? 'projects' : 'other'
    const expected = url.origin === base && request.method() === 'GET' && requestKind !== 'other'
      && identity?.confirmed === true && ['anonymous', 'revoked-current-login'].includes(identity.reason)
    // Record all 401s, including normally completed other private reads. Keep raw
    // URLs, query strings, console text and browser handles out of the evidence.
    report({ type: 'http401', expected, status: 401, method: request.method(), requestKind }, request)
  })
  return { identityFor }
}
