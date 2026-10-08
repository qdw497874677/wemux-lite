import type { AccountSession } from '@wemux/web-contract/browser-host'
import { ApiError } from './errors.ts'
import { consumeEventStream } from './event-stream.ts'

export interface ClusterTransportOptions { origin?: string; fetcher?: typeof fetch }
export type RequestMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'

/** One identity lifetime. Callers must dispose it before changing accounts or teams. */
export function createClusterTransport(config: AccountSession, onUnauthorized: () => void = () => {}, options: ClusterTransportOptions = {}) {
  const scope = new AbortController()
  const origin = new URL(options.origin ?? window.location.origin).origin
  const fetcher = options.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const teamId = config.teamId
  let csrfToken = config.csrfToken
  let refresh: Promise<boolean> | undefined
  const unsafe = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method)
  const unauthorized = () => { if (!scope.signal.aborted) { csrfToken = ''; scope.abort(); onUnauthorized() } }
  const check = (signal?: AbortSignal) => { scope.signal.throwIfAborted(); signal?.throwIfAborted() }
  function target(path: string): URL {
    const url = new URL(path, origin)
    let pathname: string
    try { pathname = decodeURIComponent(url.pathname) } catch { throw new ApiError('API 路径无效。', undefined, 'contract') }
    if (url.origin !== origin || url.username || url.password || !pathname.startsWith('/api/') || pathname === '/api/local' || pathname.startsWith('/api/local/')) {
      throw new ApiError('集群请求不能发送到其他宿主或本地 Worker API。', undefined, 'contract')
    }
    if (teamId) url.searchParams.set('teamId', teamId)
    return url
  }
  async function send(path: string, body: unknown, signal: AbortSignal | undefined, method: RequestMethod, timeoutMs: number | undefined, extra?: Record<string, string>): Promise<Response> {
    check(signal)
    const url = target(path)
    const headers: Record<string, string> = { Accept: 'application/json', ...extra }
    if (csrfToken && unsafe(method)) headers['X-CSRF-Token'] = csrfToken
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    try {
      return await fetcher(url, { method, headers, credentials: 'same-origin', redirect: 'error', cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([scope.signal, ...(signal ? [signal] : []), ...(timeoutMs === undefined ? [] : [AbortSignal.timeout(timeoutMs)])]) })
    } catch (error) {
      check(signal)
      throw new ApiError('连接失败：无法访问 Server，请检查服务是否启动、端口与网络。', undefined, 'network')
    }
  }
  async function refreshCsrf(): Promise<boolean> {
    if (!refresh) refresh = (async () => {
      const response = await send('/api/auth/me', undefined, undefined, 'GET', 15000)
      check()
      if (response.status === 401) { unauthorized(); throw new ApiError('登录会话已失效，请重新登录。', 401) }
      if (!response.ok) return false
      const account = await response.json() as { csrfToken?: string }
      check()
      if (!account.csrfToken) return false
      csrfToken = account.csrfToken
      return true
    })().finally(() => { refresh = undefined })
    return refresh
  }
  /** Error details are optional: neither a stalled body nor its cleanup may hide known HTTP status. */
  async function errorDetails(response: Response, signal?: AbortSignal): Promise<unknown> {
    if (!response.body) return undefined
    const reader = response.body.getReader()
    const lifetime = AbortSignal.any([scope.signal, ...(signal ? [signal] : [])])
    let stop!: () => void
    const stopped = new Promise<undefined>(resolve => {
      stop = () => { void reader.cancel().catch(() => {}); resolve(undefined) }
    })
    const timer = setTimeout(stop, 15000)
    lifetime.addEventListener('abort', stop, { once: true })
    try {
      if (lifetime.aborted) return undefined
      const decoder = new TextDecoder()
      let text = '', bytes = 0
      for (;;) {
        const result = await Promise.race([reader.read(), stopped])
        if (!result) return undefined
        if (result.done) return JSON.parse(text + decoder.decode()) as unknown
        bytes += result.value.byteLength
        if (bytes > 65536) return undefined
        text += decoder.decode(result.value, { stream: true })
      }
    } catch { return undefined } // Malformed, failed or timed-out details never replace the HTTP status.
    finally {
      clearTimeout(timer)
      lifetime.removeEventListener('abort', stop)
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  async function requireSuccess(response: Response, signal?: AbortSignal): Promise<void> {
    check(signal)
    if (response.status === 401) {
      unauthorized()
      throw new ApiError('请求失败（HTTP 401）：登录会话已失效，请重新登录。', 401)
    }
    if (!response.ok) {
      let detail = '', code: string | undefined
      try {
        const payload = await errorDetails(response, signal) as { error?: { message?: string; code?: string }; message?: string }
        const message = payload.error?.message ?? payload.message
        if (typeof message === 'string') detail = message
        if (typeof payload.error?.code === 'string') code = payload.error.code
      } catch { /* Preserve HTTP status for non-JSON failures. */ }
      check(signal)
      const fallback = response.status === 403 ? '当前账号无权执行此操作，或写保护令牌已失效。' : '请稍后重试；如持续失败，请检查 Server 日志。'
      throw new ApiError(`请求失败（HTTP ${response.status}）：${detail || fallback}`, response.status, undefined, code)
    }
  }
  async function request<T>(path: string, body?: unknown, signal?: AbortSignal, method?: RequestMethod, timeoutMs = 15000, extra?: Record<string, string>): Promise<T> {
    const resolved = method ?? (body === undefined ? 'GET' : 'POST')
    let response = await send(path, body, signal, resolved, timeoutMs, extra)
    check(signal)
    // Only writes can have stale CSRF. A forbidden read remains a permission error.
    if (response.status === 403 && csrfToken && unsafe(resolved)) {
      let refreshed = false
      try { refreshed = await refreshCsrf() } catch (error) {
        if (error instanceof ApiError && error.status === 401) throw error
        check(signal)
      }
      check(signal)
      if (refreshed) response = await send(path, body, signal, resolved, timeoutMs, extra)
    }
    check(signal)
    await requireSuccess(response, signal)
    if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as T
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new ApiError('服务端响应格式异常，请检查当前访问地址是否为 Wemux Lite Server。', undefined, 'contract')
    let value: T
    try { value = await response.json() as T } catch { check(signal); throw new ApiError('API 响应不是有效的 JSON。', undefined, 'contract') }
    check(signal)
    return value
  }
  /** One SSE connection. The consumer receives event names only, never cursor IDs or payloads. */
  async function stream(path: string, onEvent: (event: string) => void, signal?: AbortSignal): Promise<void> {
    const connection = new AbortController()
    const combined = AbortSignal.any([scope.signal, connection.signal, ...(signal ? [signal] : [])])
    const timer = setTimeout(() => connection.abort(new ApiError('事件流连接超时。', undefined, 'network')), 15000)
    let response: Response | undefined
    try {
      response = await send(path, undefined, combined, 'GET', undefined, { Accept: 'text/event-stream' })
      // Once headers establish a status, connection timeout must not reclassify a permission error.
      clearTimeout(timer)
      await requireSuccess(response, signal)
      if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream' || !response.body) {
        throw new ApiError('事件流响应格式异常。', undefined, 'contract')
      }
      await consumeEventStream(response.body, onEvent, combined)
      check(combined)
    } finally {
      clearTimeout(timer)
      // Includes responses arriving after disposal and non-SSE/error responses.
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {})
    }
  }
  async function list<T>(path: string, signal?: AbortSignal): Promise<T[]> {
    const value = await request<{ items: T[] }>(path, undefined, signal)
    if (!value || !Array.isArray(value.items)) throw new ApiError('API 契约错误：列表响应应包含 items 数组。', undefined, 'contract')
    return value.items
  }
  return { request, list, stream, signal: scope.signal, unauthorized, setCsrfToken: (value: string) => { check(); csrfToken = value }, dispose: () => { csrfToken = ''; scope.abort() } }
}
