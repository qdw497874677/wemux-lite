export class AppError extends Error {
  readonly status: number
  readonly code?: string
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code }
}
export function requireValue<T>(value: T | null | undefined, message = 'Not found'): T {
  if (value == null) throw new AppError(404, message)
  return value
}
