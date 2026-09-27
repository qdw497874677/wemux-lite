import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { Plus, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Api } from '../../api/client.ts'
import { Button } from '../../components/ui/button.tsx'
import { cn } from '../../lib/utils.ts'
import { setTerminalContext } from './terminal-context.ts'

type Entry = { id: string; title: string; terminal: Terminal; fit: FitAddon; element: HTMLDivElement; lines: string[] }
const cleanLines = (data: string) => data.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '').replace(/\r/g, '').split('\n')

export function TerminalPanel({ api, sessionId, active }: { api: Api; sessionId: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const entries = useRef(new Map<string, Entry>())
  const [ids, setIds] = useState<string[]>([])
  const [current, setCurrent] = useState('')
  const [error, setError] = useState('')
  const publish = useCallback((id: string) => { const entry = entries.current.get(id); setTerminalContext(sessionId, { active, terminalId: id || null, lines: entry?.lines.slice(-100) ?? [] }) }, [active, sessionId])
  const select = useCallback((id: string) => {
    setCurrent(id)
    for (const [key, entry] of entries.current) entry.element.hidden = key !== id
    const entry = entries.current.get(id)
    if (entry) requestAnimationFrame(() => { entry.fit.fit(); entry.terminal.focus(); void api.resizeTerminal(sessionId, id, entry.terminal.cols, entry.terminal.rows).catch(() => undefined); publish(id) })
  }, [api, publish, sessionId])
  const create = useCallback(async () => {
    if (!host.current) return
    setError('')
    try {
      const result = await api.createTerminal(sessionId)
      const terminal = new Terminal({ cursorBlink: true, convertEol: true, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', theme: { background: '#090b10', foreground: '#e5e7eb', cursor: '#a78bfa' } })
      const fit = new FitAddon(); terminal.loadAddon(fit)
      const element = document.createElement('div'); element.className = 'h-full w-full'; host.current.append(element); terminal.open(element); fit.fit()
      const entry: Entry = { id: result.terminalId, title: `终端 ${entries.current.size + 1}`, terminal, fit, element, lines: [] }
      entries.current.set(entry.id, entry); setIds([...entries.current.keys()]); select(entry.id)
      await api.resizeTerminal(sessionId, entry.id, terminal.cols, terminal.rows).catch(() => undefined)
      terminal.onData(data => { void api.writeTerminal(sessionId, entry.id, data).catch(cause => setError(cause instanceof Error ? cause.message : '终端输入失败')) })
      terminal.onResize(size => { void api.resizeTerminal(sessionId, entry.id, size.cols, size.rows).catch(() => undefined) })
    } catch (cause) { setError(cause instanceof Error ? cause.message : '终端创建失败') }
  }, [api, select, sessionId])
  const close = useCallback(async (id: string) => {
    const entry = entries.current.get(id); if (!entry) return
    entries.current.delete(id); entry.terminal.dispose(); entry.element.remove(); setIds([...entries.current.keys()]); void api.disposeTerminal(sessionId, id).catch(() => undefined)
    const next = [...entries.current.keys()].at(-1) ?? ''; select(next)
  }, [api, select, sessionId])
  useEffect(() => { if (active && !ids.length) void create() }, [active, create, ids.length])
  useEffect(() => { publish(current) }, [active, current, publish])
  useEffect(() => {
    const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/stream`)
    source.addEventListener('terminal.output', event => { const payload = JSON.parse((event as MessageEvent).data) as { terminalId: string; data: string }; const entry = entries.current.get(payload.terminalId); if (!entry) return; entry.terminal.write(payload.data); entry.lines.push(...cleanLines(payload.data)); entry.lines = entry.lines.slice(-200); if (payload.terminalId === current) publish(current) })
    source.addEventListener('terminal.exit', event => { const payload = JSON.parse((event as MessageEvent).data) as { terminalId: string; exitCode: number }; entries.current.get(payload.terminalId)?.terminal.writeln(`\r\n[进程已退出：${payload.exitCode}]`) })
    source.onerror = () => setError('终端输出连接正在重连')
    return () => source.close()
  }, [current, publish, sessionId])
  useEffect(() => {
    const node = host.current; if (!node) return
    const observer = new ResizeObserver(() => { const entry = entries.current.get(current); if (entry && active) entry.fit.fit() })
    observer.observe(node); return () => observer.disconnect()
  }, [active, current])
  useEffect(() => () => { for (const entry of entries.current.values()) { entry.terminal.dispose(); entry.element.remove(); void api.disposeTerminal(sessionId, entry.id).catch(() => undefined) } entries.current.clear(); setTerminalContext(sessionId, { active: false, terminalId: null, lines: [] }) }, [api, sessionId])
  return <section className="flex h-full min-h-0 flex-col bg-[#090b10] text-slate-200">
    <header className="flex min-h-10 items-center gap-1 border-b border-white/10 px-2"><div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">{ids.map(id => <button key={id} className={cn('flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs', id === current ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5')} onClick={() => select(id)}>{entries.current.get(id)?.title}<X className="size-3" onClick={event => { event.stopPropagation(); void close(id) }} /></button>)}</div><Button size="icon" variant="ghost" className="size-7 text-slate-300" onClick={() => void create()} disabled={ids.length >= 5} aria-label="新建终端"><Plus className="size-4" /></Button></header>
    {error && <p className="border-b border-amber-500/20 bg-amber-500/10 px-3 py-1 text-xs text-amber-200">{error}</p>}
    <div ref={host} className="min-h-0 flex-1 p-2" />
    <footer className="border-t border-white/10 px-3 py-1.5 text-[10px] text-slate-500">会话结束后终端自动关闭。终端可在工作区外执行 cd，当前不提供 chroot 隔离。</footer>
  </section>
}
