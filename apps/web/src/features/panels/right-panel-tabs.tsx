/* Derived from pingdotgg/t3code (MIT). */
import { ChevronDown, PanelRightClose, X } from 'lucide-react'
import { useEffect, useRef, useSyncExternalStore } from 'react'

import { Button } from '../../components/ui/button.tsx'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../components/ui/dropdown-menu.tsx'
import { Kbd } from '../../components/ui/kbd.tsx'
import { createPanelLifetime } from '../../lib/panel-lifetime.ts'
import { cn } from '../../lib/utils.ts'
import type { PanelDescriptor, PanelRenderContext } from './panel-registry.ts'

export function RightPanelTabs<Context extends PanelRenderContext>({ descriptors, activeId, context, onActivate, onClose }: {
  descriptors: readonly PanelDescriptor<Context>[]
  activeId: string
  context: Context
  onActivate: (id: string) => void
  onClose: () => void
}) {
  const active = descriptors.find(panel => panel.id === activeId) ?? descriptors[0]
  const lifetimeRef = useRef<ReturnType<typeof createPanelLifetime> | null>(null)
  if (!lifetimeRef.current) lifetimeRef.current = createPanelLifetime()
  const lifetime = lifetimeRef.current
  const retainedKey = useSyncExternalStore(lifetime.subscribe, () => lifetime.retainedKeys().join('\u0000'), () => '')
  useEffect(() => {
    if (!active) return
    const lease = lifetime.acquire(active.id, { keepAlive: active.keepAlive })
    return lease.release
  }, [active?.id, active?.keepAlive, lifetime])
  useEffect(() => () => lifetime.dispose(), [lifetime])
  const retained = new Set(retainedKey ? retainedKey.split('\u0000') : [])
  const visible = descriptors.filter(panel => panel.id === active?.id || retained.has(panel.id))
  if (!active) return null
  const ActiveIcon = active.icon
  return <aside className="right-panel flex h-full min-h-0 w-full flex-col bg-card/75 text-foreground backdrop-blur-[var(--glass-blur)]">
    <header className="flex min-h-10 shrink-0 items-center gap-1 border-b border-contrast-border bg-background/35 px-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="会话面板">
        {descriptors.map(panel => {
          const Icon = panel.icon
          const selected = panel.id === active.id
          return <button key={panel.id} type="button" role="tab" aria-selected={selected} className={cn('ring-focus inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--control-radius)] px-2 text-xs transition-colors', selected ? 'bg-accent text-contrast-foreground shadow-xs' : 'text-contrast-muted-foreground/60 hover:bg-accent/70 hover:text-contrast-foreground')} onClick={() => onActivate(panel.id)}><Icon className="size-3.5" /><span className="hidden 2xl:inline">{panel.title}</span></button>
        })}
      </div>
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label={`切换面板，当前为${active.title}`}><ActiveIcon className="size-3.5" /><ChevronDown className="size-3" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-52 p-1">{descriptors.map(panel => { const Icon = panel.icon; return <DropdownMenuItem key={panel.id} onSelect={() => onActivate(panel.id)} className={cn(panel.id === active.id && 'bg-dropdown-hover-background text-title-50')}><Icon className="size-4" /><span className="flex-1">{panel.title}</span>{panel.id === active.id && <span className="text-xs text-muted-foreground">当前</span>}</DropdownMenuItem> })}</DropdownMenuContent></DropdownMenu>
      <Button variant="ghost" size="icon" className="size-8" onClick={onClose} aria-label="收起右侧面板"><PanelRightClose className="size-4" /></Button>
    </header>
    <div className="relative min-h-0 flex-1">
      {visible.map(panel => <div key={panel.id} role="tabpanel" aria-label={panel.title} hidden={panel.id !== active.id} className="absolute inset-0 min-h-0 overflow-hidden">{panel.render(context)}</div>)}
    </div>
    <footer className="flex shrink-0 items-center justify-between border-t border-contrast-border px-3 py-1.5 text-[10px] text-contrast-muted-foreground"><span>切换面板后状态继续保留</span><span className="inline-flex items-center gap-1"><Kbd>⌘/Ctrl</Kbd><Kbd>B</Kbd><span>收起</span><Button variant="ghost" size="icon" className="ml-1 size-5 sm:hidden" onClick={onClose} aria-label="关闭面板"><X className="size-3" /></Button></span></footer>
  </aside>
}
