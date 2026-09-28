import { useCallback, useEffect, useState } from 'react'
import type { CursorPage } from './projection-model.ts'

export function useProjectionPage<T>(load: (cursor?: string) => Promise<CursorPage<T>>, dependencyKey: string) {
  const [items, setItems] = useState<readonly T[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try { const page = await load(); setItems(page.items); setNextCursor(page.nextCursor) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '加载失败') }
    finally { setLoading(false) }
  }, [load, dependencyKey])
  useEffect(() => { void refresh() }, [refresh])
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true); setError(null)
    try { const page = await load(nextCursor); setItems(current => [...current, ...page.items]); setNextCursor(page.nextCursor) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '加载失败') }
    finally { setLoadingMore(false) }
  }, [load, nextCursor, loadingMore])
  return { items, nextCursor, loading, loadingMore, error, refresh, loadMore, setItems }
}
