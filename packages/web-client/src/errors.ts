export type ClientErrorKind = 'unauthorized' | 'forbidden' | 'not-found' | 'network' | 'server' | 'contract' | 'cancelled' | 'unexpected'

export class ApiError extends Error {
  readonly status?: number
  readonly kind: ClientErrorKind
  readonly code?: string
  constructor(message: string, status?: number, kind?: ClientErrorKind, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.kind = kind ?? (status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not-found' : 'server')
  }
}

export function classifyClientError(error: unknown): ClientErrorKind {
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled'
  return error instanceof ApiError ? error.kind : 'unexpected'
}
