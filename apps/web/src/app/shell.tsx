import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '../components/ui/button'
export function AppShell({ children }: { children: ReactNode }) { return <div className="flex h-[100dvh] min-w-80 flex-col overflow-hidden bg-background text-foreground">{children}</div> }
export function GlobalRail({ children }: { children: ReactNode }) { return <nav aria-label="全局导航" className="global-rail">{children}</nav> }
export function ProjectNavigation({ children }: { children: ReactNode }) { return <nav aria-label="项目页面" className="flex flex-col gap-1 border-b border-border p-3">{children}</nav> }
export function MainCanvas({ children }: { children: ReactNode }) { return <main className="flex min-h-0 min-w-0 flex-col">{children}</main> }
/** The host and its subtree never remount on resize: form state, selection and focus survive. */
export function InspectorHost({ children, open, onOpenChange }: { children: ReactNode; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [wide, setWide] = useState(() => matchMedia('(min-width: 1280px)').matches)
  const [width, setWidth] = useState(520)
  const panel = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const media = matchMedia('(min-width: 1280px)')
    const change = () => setWide(media.matches)
    media.addEventListener('change', change); return () => media.removeEventListener('change', change)
  }, [])
  useLayoutEffect(() => {
    if (!open) return
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [open])
  useLayoutEffect(() => {
    if (!open || wide || !panel.current) return
    const host = panel.current
    // Disable every background branch, including the header, without moving the host.
    const background: HTMLElement[] = []
    let branch: HTMLElement = host
    while (branch.parentElement && branch.parentElement !== document.body) {
      for (const sibling of branch.parentElement.children) if (sibling instanceof HTMLElement && sibling !== branch && !sibling.hasAttribute('data-inspector-overlay') && !sibling.inert) { sibling.inert = true; background.push(sibling) }
      branch = branch.parentElement
    }
    if (!host.contains(document.activeElement)) host.querySelector<HTMLElement>('button')?.focus()
    return () => { background.forEach(node => { node.inert = false }) }
  }, [open, wide])
  const close = () => { onOpenChange(false) }
  // Restore after the modal layout cleanup removes background inertness.
  useEffect(() => {
    if (open) return
    const target = trigger.current
    if (target?.isConnected && target !== document.body) target.focus()
    else document.querySelector<HTMLElement>('[data-inspector-trigger]')?.focus()
  }, [open])
  if (!open) return null
  return <>{!wide && <div data-inspector-overlay className="fixed inset-0 z-40 bg-black/60" onClick={close} />}
    <aside ref={panel} aria-label="资源详情" role={wide ? undefined : 'dialog'} aria-modal={wide ? undefined : true} style={{ width: `min(100vw, ${width}px)` }} className={wide ? 'relative flex min-h-0 flex-col border-l border-border' : 'inspector-sheet fixed right-0 top-0 z-50 flex h-dvh flex-col bg-background'} onKeyDown={event => {
      if (wide) return
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'Tab') {
        const items = Array.from(panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select,textarea,summary,[tabindex="0"]')).filter(item => item.getClientRects().length)
        const first = items[0], last = items.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <div onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setWidth(Math.max(480, Math.min(560, window.innerWidth - event.clientX))) }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} role="separator" aria-label="调整详情宽度" aria-orientation="vertical" aria-valuemin={480} aria-valuemax={560} aria-valuenow={width} tabIndex={0} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); setWidth(value => Math.max(480, Math.min(560, value + (event.key === 'ArrowLeft' ? 10 : -10)))) } }} className="absolute inset-y-0 left-0 w-2 cursor-col-resize" />
      <Button variant="outline" aria-label={wide ? '关闭详情' : '关闭面板'} className="m-3 text-foreground" onClick={close}>关闭详情</Button>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto p-4 [overflow-wrap:anywhere]">{children}</div>
    </aside></>
}
