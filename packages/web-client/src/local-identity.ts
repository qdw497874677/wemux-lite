import type { LocalStatus } from '@wemux/web-contract/browser-host'
import { ApiError } from './errors.ts'

/** Local Worker identity is deliberately separate from cluster account sessions and headers. */
export function createLocalTransport(fetcher: typeof fetch = fetch, onUnauthorized: () => void = () => {}) {
  let csrf = ''
  let scope = new AbortController()
  let disposed = false
  const request = async <T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> => {
    // The legacy local workbench retains its API object across reauthentication.
    // Capture the generation so late responses cannot enter the replacement identity.
    if (!disposed && scope.signal.aborted && path === 'auth/session' && method === 'POST') scope = new AbortController()
    const identity = scope
    const check = (signal?: AbortSignal) => { identity.signal.throwIfAborted(); signal?.throwIfAborted() }
    check(signal)
    const url = new URL(`/api/local/${path}`, 'http://local.invalid')
    const pathname = decodeURIComponent(url.pathname)
    if (!pathname.startsWith('/api/local/') || pathname.includes('\\')) throw new ApiError('本地请求不能发送到其他宿主 API。', undefined, 'contract')
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (method !== 'GET') { headers['x-wemux-csrf'] = csrf; headers['content-type'] = 'application/json' }
    let response: Response
    try {
      response = await fetcher(`${url.pathname}${url.search}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([identity.signal, ...(signal ? [signal] : [])]), credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
    } catch { check(signal); throw new ApiError('无法连接本地 Worker，请检查网络后重试。', undefined, 'network') }
    check(signal)
    if (response.status === 401 && path !== 'auth/session' && path !== 'status') { csrf = ''; identity.abort(); onUnauthorized() }
    if (!response.ok) {
      let message = `本地请求失败：HTTP ${response.status}`
      try { const error = await response.json() as { error?: string; message?: string }; if (typeof error.message === 'string') message = error.message; else if (typeof error.error === 'string') message = error.error } catch { /* Keep HTTP status. */ }
      throw new ApiError(message, response.status)
    }
    if (response.status === 204) return undefined as T
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new ApiError('本地响应格式异常。', undefined, 'contract')
    let value: T
    try { value = await response.json() as T } catch { check(signal); throw new ApiError('本地响应不是有效的 JSON。', undefined, 'contract') }
    check(signal)
    return value
  }
  return { request, setCsrfToken: (value: string) => { scope.signal.throwIfAborted(); csrf = value }, dispose: () => { disposed = true; csrf = ''; scope.abort() } }
}

export function localIdentityOperations(transport: ReturnType<typeof createLocalTransport>) {
  const { request, setCsrfToken } = transport
  const status = async () => { const result = await request<LocalStatus>('status'); setCsrfToken(result.csrf); return result }
  return {
    status,
    async login(username: string, password: string) {
      const result = await request<{ csrf: string }>('auth/session', 'POST', { username, password })
      setCsrfToken(result.csrf)
      return status()
    },
    async logout() { await request<void>('auth/session', 'DELETE'); setCsrfToken('') },
  }
}

export function createLocalIdentityClient(fetcher: typeof fetch = fetch, onUnauthorized: () => void = () => {}) {
  const transport = createLocalTransport(fetcher, onUnauthorized)
  return { ...localIdentityOperations(transport), dispose: transport.dispose }
}
