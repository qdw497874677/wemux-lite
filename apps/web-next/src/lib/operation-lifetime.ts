import { useLayoutEffect, useRef } from 'react'

/** Capture before awaiting a write. A retired scope cannot navigate or reload another page.
 * Each effect activation has a distinct token, including StrictMode cleanup/restart. */
export function useOperationLifetime(scope: readonly unknown[]) {
  const current = useRef<object | undefined>(undefined)
  useLayoutEffect(() => {
    const token = {}; current.current = token
    return () => { if (current.current === token) current.current = undefined }
  }, scope)
  return () => { const token = current.current; return () => token !== undefined && current.current === token }
}
