import type { Api } from '../api/client.ts'
import type { EventsPageDTO, FreshnessDTO, JournalEventDTO } from '../api/dto.ts'

/** Journal pagination and subscription are identical to the Session Surface regardless of host. */
export type SessionJournal = Pick<Api, 'events' | 'watch'>

export interface LocalJournalPage { events: JournalEventDTO[]; throughSeq: number; hasMore: boolean }

export function normalizeLocalJournalPage(page: LocalJournalPage, afterSeq: number): EventsPageDTO & { freshness: FreshnessDTO } {
  if (!page || !Array.isArray(page.events) || typeof page.hasMore !== 'boolean' || !Number.isSafeInteger(page.throughSeq) || page.throughSeq < 0) throw new Error('本地 Journal 分页响应无效')
  const last = page.events.at(-1)?.seq ?? afterSeq
  if (page.throughSeq !== last || page.events.some((event, index) => event.seq !== afterSeq + index + 1)) throw new Error('本地 Journal 游标存在 gap')
  return { events: page.events, throughSeq: last, hasMore: page.hasMore, freshness: { status: 'synced', throughSeq: last } }
}

/** The local Worker owns its own cookie; this Adapter never sends cluster credentials. */
export function createLocalJournal(fetcher: typeof fetch = fetch, onUnauthorized: () => void = () => {}): SessionJournal {
  const path = (sessionId: string) => `/api/local/workbench/sessions/${encodeURIComponent(sessionId)}`
  const read = async (sessionId: string, afterSeq: number, signal?: AbortSignal) => {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('本地 Journal 游标无效')
    const response = await fetcher(`${path(sessionId)}/journal?fromSeq=${afterSeq + 1}&limit=500`, { credentials: 'same-origin', signal, headers: { Accept: 'application/json' }, cache: 'no-store' })
    if (response.status === 401) onUnauthorized()
    if (!response.ok) throw new Error(`本地 Journal 请求失败：HTTP ${response.status}`)
    return normalizeLocalJournalPage(await response.json() as LocalJournalPage, afterSeq)
  }
  return {
    events: read,
    watch(sessionId, afterSeq, onChange, onState) {
      const controller = new AbortController()
      const run = async () => {
        // SSE hints are not a verified journal cursor. Reconnect from the last
        // paged/validated position; duplicates are safe, silently skipped gaps are not.
        const fromSeq = afterSeq + 1
        while (!controller.signal.aborted) {
          try {
            const response = await fetcher(`${path(sessionId)}/events?fromSeq=${fromSeq}`, { credentials: 'same-origin', signal: controller.signal, headers: { Accept: 'text/event-stream' }, cache: 'no-store' })
            if (response.status === 401) { onUnauthorized(); return }
            if (!response.ok || !response.body) throw new Error(`本地 Journal 实时流失败：HTTP ${response.status}`)
            onState('live'); onChange()
            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            try {
              while (!controller.signal.aborted) {
                const chunk = await reader.read()
                if (chunk.done) break
                buffer += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n')
                let end: number
                while ((end = buffer.indexOf('\n\n')) >= 0) {
                  const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
                  if (frame.includes('event: auth-expired')) { onUnauthorized(); return }
                  if (frame.split('\n').some(line => line.startsWith('data:'))) onChange()
                }
              }
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
          } catch { if (controller.signal.aborted) return }
          if (!controller.signal.aborted) {
            onState('reconnecting')
            await new Promise<void>(resolve => { const timer = setTimeout(resolve, 1000); controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true }) })
          }
        }
      }
      void run()
      return () => controller.abort()
    },
  }
}

export function createClusterJournal(api: Api): SessionJournal { return api }
