// Deliberately conservative: epochs alone and URL suffixes are not lifecycle evidence.
export function expectedAcceptanceAbort({ method, path, status, contentType = '', aborted, startEpoch, navigation, identity }) {
  if (!aborted || method !== 'GET') return false
  const accountRead = ['/api/auth/me', '/api/projects'].includes(path)
  const sessionRead = /^\/api\/sessions\/[^/]+(?:\/events)?$/.test(path)
  const sessionStream = /^\/api\/sessions\/[^/]+\/stream$/.test(path)
  const projectRead = /^\/api\/projects\/[^/]+(?:\/(?:events|sessions|workspaces|tasks))?$/.test(path)
  const knownRead = accountRead || sessionRead || sessionStream || projectRead || ['/api/sessions', '/api/workers'].includes(path)
  if (!knownRead) return false
  if (status === 401 && accountRead && identity?.confirmed === true && ['anonymous', 'revoked-current-login'].includes(identity.reason)) return true
  const responseType = sessionStream ? /^text\/event-stream(?:;|$)/i : /^(application\/json|text\/event-stream)(?:;|$)/i
  return status === 200 && responseType.test(contentType)
    && navigation?.confirmed === true && navigation.requestWasPending === true
    && ['goto', 'reload', 'goBack'].includes(navigation.method)
    && navigation.fromEpoch === startEpoch && navigation.toEpoch === startEpoch + 1
}
