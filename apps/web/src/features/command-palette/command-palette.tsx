import { Bot, Files, Info, LayoutPanelLeft, MessageSquarePlus, PanelRight, Search, TerminalSquare, Workflow } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent } from 'react'

import type { SessionDTO } from '../../api/dto.ts'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../components/ui/dialog.tsx'
import { Kbd } from '../../components/ui/kbd.tsx'
import { cn } from '../../lib/utils.ts'
import { executePaletteItem, filterPaletteItems, nextPaletteSelection, orderCommandsByRecent, paletteTextSegments, readRecentCommandIds, sessionPaletteItems, type CommandPaletteItem } from './model.ts'

type PaletteCommand = Omit<CommandPaletteItem, 'kind'> & { icon: ComponentType<{ className?: string }> }

const icons: Record<string, ComponentType<{ className?: string }>> = {
  'new-session': MessageSquarePlus,
  'panel:session-info': Info,
  'panel:session-canvas': Workflow,
  'panel:files': Files,
  'panel:terminal': TerminalSquare,
  'panel:agents': Bot,
  'toggle-right-panel': PanelRight,
  'toggle-sidebar': LayoutPanelLeft,
}

export function CommandPalette({ open, onOpenChange, projectId, sessions, commands, onOpenSession }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  sessions: readonly SessionDTO[]
  commands: readonly Omit<PaletteCommand, 'kind' | 'icon'>[]
  onOpenSession: (sessionId: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [recent, setRecent] = useState<string[]>(() => readRecentCommandIds(window.localStorage))
  const commandItems = useMemo(() => orderCommandsByRecent(commands.map(command => ({ ...command, kind: 'command' as const })), recent), [commands, recent])
  const sessionItems = useMemo(() => sessionPaletteItems(sessions, projectId, onOpenSession), [onOpenSession, projectId, sessions])
  const visibleCommands = useMemo(() => filterPaletteItems(commandItems, query), [commandItems, query])
  const visibleSessions = useMemo(() => filterPaletteItems(sessionItems, query), [query, sessionItems])
  const items = [...visibleCommands, ...visibleSessions]

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(0)
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])
  useEffect(() => { setSelected(0) }, [query])
  useEffect(() => {
    const item = items[selected]
    if (item) itemRefs.current.get(item.id)?.scrollIntoView({ block: 'nearest' })
  }, [items, selected])

  const execute = (item: CommandPaletteItem | undefined) => {
    if (!item || item.disabled) return
    setRecent(value => executePaletteItem(item, window.localStorage, value))
    onOpenChange(false)
  }
  const highlightedLabel = (item: CommandPaletteItem) => paletteTextSegments(item.label, query).map((segment, index) => segment.highlighted
    ? <mark key={index} className="bg-transparent font-semibold text-foreground">{segment.text}</mark>
    : segment.text)
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setSelected(value => nextPaletteSelection(value, 1, items.length)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setSelected(value => nextPaletteSelection(value, -1, items.length)) }
    else if (event.key === 'Enter') { event.preventDefault(); execute(items[selected]) }
  }
  const renderItem = (item: CommandPaletteItem, index: number) => {
    const Icon = item.kind === 'session' ? Search : icons[item.id] ?? Search
    return <button
      key={item.id}
      ref={node => {
        if (node) itemRefs.current.set(item.id, node)
        else itemRefs.current.delete(item.id)
      }}
      type="button"
      role="option"
      aria-selected={selected === index}
      disabled={item.disabled}
      className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors', selected === index ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground', item.disabled && 'cursor-not-allowed opacity-45')}
      onPointerMove={() => setSelected(index)}
      onClick={() => execute(item)}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border/70 bg-background/55"><Icon className="size-4" /></span>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-foreground">{highlightedLabel(item)}</span><span className="block truncate text-xs text-muted-foreground">{item.description}</span></span>
      {item.kind === 'command' && recent.includes(item.id) && <span className="text-[10px] text-muted-foreground">最近</span>}
    </button>
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="surface-glass top-[42%] max-w-2xl overflow-hidden border-border/70 p-0 shadow-2xl [&>button]:hidden" aria-label="命令面板" onOpenAutoFocus={event => { event.preventDefault(); inputRef.current?.focus() }}>
      <DialogTitle className="sr-only">命令面板</DialogTitle>
      <DialogDescription className="sr-only">搜索当前项目会话或执行工作台命令</DialogDescription>
      <div className="flex items-center gap-3 border-b border-border/70 px-4">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input ref={inputRef} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={keyDown} className="h-14 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground" placeholder="搜索命令或当前项目会话…" aria-label="搜索命令或会话" aria-controls="command-palette-results" autoComplete="off" />
        <Kbd>Esc</Kbd>
      </div>
      <div id="command-palette-results" role="listbox" className="max-h-[min(26rem,60vh)] overflow-y-auto p-2">
        {!items.length ? <div className="grid min-h-32 place-content-center gap-1 text-center"><p className="text-sm font-medium text-foreground">没有匹配结果</p><p className="text-xs text-muted-foreground">当前仅搜索命令与会话标题，时间线文本搜索后续接入 journal 数据。</p></div> : <>
          {visibleCommands.length > 0 && <section><p className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{query ? '命令' : recent.some(id => visibleCommands.some(item => item.id === id)) ? '命令 · 最近使用置顶' : '命令'}</p>{visibleCommands.map((item, index) => renderItem(item, index))}</section>}
          {visibleSessions.length > 0 && <section><p className="px-3 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">当前项目会话 · 标题匹配</p>{visibleSessions.map((item, index) => renderItem(item, visibleCommands.length + index))}</section>}
          {!query && !visibleSessions.length && <p className="px-3 py-4 text-xs text-muted-foreground">当前项目暂无可搜索会话。仍可执行上方命令。</p>}
        </>}
      </div>
      <footer className="flex items-center justify-between border-t border-border/70 px-4 py-2 text-[10px] text-muted-foreground"><span>时间线文本搜索尚未接入</span><span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd><span>选择</span><Kbd>↵</Kbd><span>执行</span></span></footer>
    </DialogContent>
  </Dialog>
}
