import { useEffect, useMemo, useState } from 'react'
import type { Api } from './client'
import type { FreshnessDTO, JournalEventDTO, SessionDTO } from './dto'
import { appendPage, projectJournal } from './journal'

export function useSession(api: Api, sessionId: string, revision: number) {
  const [data, setData] = useState<{ id: string; events: JournalEventDTO[]; freshness?: FreshnessDTO; error: string; stream: string; checkedAt: number }>({ id: '', events: [], error: '', stream: 'connecting', checkedAt: 0 })
  useEffect(() => {
    setData({ id: sessionId, events: [], error: '', stream: 'connecting', checkedAt: 0 })
    if (!sessionId) return
    const controller = new AbortController()
    let events: JournalEventDTO[] = []
    let cursor = 0
    let freshness: FreshnessDTO = { status: 'unknown' }
    let syncing = false
    let dirty = false
    let closeStream: (() => void) | undefined
    async function sync() {
      if (syncing) { dirty = true; return }
      syncing = true
      try {
        do {
          dirty = false
          let hasMore = true
          while (hasMore && !controller.signal.aborted) {
            const page = await api.events(sessionId, cursor, controller.signal)
            const next = appendPage(events, page.events, sessionId)
            const nextCursor = next.at(-1)?.seq ?? 0
            if (page.hasMore && nextCursor <= cursor) throw new Error('事件分页未推进，已停止同步。')
            if (page.throughSeq < cursor || page.throughSeq !== nextCursor) throw new Error('事件游标与历史不一致，需要重新加载。')
            freshness = page.freshness
            events = next
            cursor = nextCursor
            hasMore = page.hasMore
          }
          if (controller.signal.aborted) return
          setData(current => ({ ...current, events: [...events], freshness, error: '', checkedAt: Date.now() }))
          if (!closeStream) {
            closeStream = api.watch(sessionId, cursor, () => { void sync() }, stream => {
              if (!controller.signal.aborted) setData(current => ({ ...current, stream }))
            })
          }
        } while (dirty && !controller.signal.aborted)
      } catch (error) {
        if (!controller.signal.aborted) setData(current => ({ ...current, error: error instanceof Error ? error.message : '历史加载失败' }))
      } finally { syncing = false }
    }
    void sync()
    // Poll also catches silent SSE loss, metadata changes, and named events not yet agreed upon.
    const timer = window.setInterval(() => { void sync() }, 5000)
    return () => { controller.abort(); closeStream?.(); window.clearInterval(timer) }
  }, [api, sessionId, revision])
  const visible = data.id === sessionId ? data : { id: sessionId, events: [], error: '', stream: 'connecting', checkedAt: 0 }
  const journal = useMemo(() => projectJournal(visible.events), [visible.events])
  return { ...visible, ...journal }
}
