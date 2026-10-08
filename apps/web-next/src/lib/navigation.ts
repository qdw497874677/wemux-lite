import { useEffect, useState } from 'react'
import { randomId } from '@wemux/web-client'
import { confirmNavigation, hasUnsaved } from './unsaved-navigation.ts'

export type Location = { path: string; search: string; hash: string; key: string; pop: boolean }
function read(pop = false): Location {
  if (!window.history.state?.wemuxKey) window.history.replaceState({ ...window.history.state, wemuxKey: randomId(), wemuxIndex: 0 }, '', window.location.href)
  return { path: window.location.pathname, search: window.location.search, hash: window.location.hash, key: window.history.state.wemuxKey, pop }
}
export function navigate(target: string, replace = false) {
  if (!confirmNavigation()) return
  const index = window.history.state?.wemuxIndex ?? 0
  window.history[replace ? 'replaceState' : 'pushState']({ wemuxKey: randomId(), wemuxIndex: index + (replace ? 0 : 1) }, '', target)
  window.dispatchEvent(new Event('wemux:navigate'))
}
export function useLocation() {
  const [location, setLocation] = useState(() => read())
  useEffect(() => {
    let index = window.history.state?.wemuxIndex ?? 0, restoring = false
    const pop = () => {
      if (restoring) { restoring = false; return }
      const next = window.history.state?.wemuxIndex
      if (!confirmNavigation()) {
        if (typeof next === 'number' && next !== index) { restoring = true; window.history.go(index - next) }
        return
      }
      const value = read(true); index = window.history.state?.wemuxIndex ?? 0; setLocation(value)
    }
    const push = () => { index = window.history.state?.wemuxIndex ?? 0; setLocation(read()) }
    const unload = (event: BeforeUnloadEvent) => { if (hasUnsaved()) { event.preventDefault(); event.returnValue = '' } }
    const link = (event: MouseEvent) => {
      const anchor = (event.target as Element)?.closest?.('a')
      if (event.defaultPrevented || !anchor || anchor.target === '_blank' || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      // SPA links already passed navigate(); plain links leave through the browser.
      if (!confirmNavigation()) event.preventDefault()
    }
    window.addEventListener('popstate', pop); window.addEventListener('wemux:navigate', push)
    window.addEventListener('beforeunload', unload); document.addEventListener('click', link)
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener('wemux:navigate', push); window.removeEventListener('beforeunload', unload); document.removeEventListener('click', link) }
  }, [])
  return location
}
