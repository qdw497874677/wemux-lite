import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Api } from '../../api/client.ts'
import type { FileEntryDTO, FileReadDTO } from '../../api/dto.ts'
import { Button } from '../../components/ui/button.tsx'
import { FilePreview } from './file-preview.tsx'
import { FileTree } from './file-tree.tsx'

export function FilesPanel({ api, sessionId }: { api: Api; sessionId: string }) {
  const [entries, setEntries] = useState<ReadonlyMap<string, readonly FileEntryDTO[]>>(new Map())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set())
  const [selectedPath, setSelectedPath] = useState('')
  const [preview, setPreview] = useState<FileReadDTO | null>(null)
  const [error, setError] = useState('')
  const entriesRef = useRef(entries)
  useEffect(() => { entriesRef.current = entries }, [entries])

  const loadDirectory = useCallback(async (path: string, force = false) => {
    if (!force && entriesRef.current.has(path)) return
    setLoading(current => new Set(current).add(path)); setError('')
    try {
      const result = await api.listSessionFiles(sessionId, path)
      setEntries(current => { const next = new Map(current); next.set(path, result.entries); return next })
    } catch (cause) { setError(cause instanceof Error ? cause.message : '文件列表加载失败') }
    finally { setLoading(current => { const next = new Set(current); next.delete(path); return next }) }
  }, [api, sessionId])

  useEffect(() => {
    setEntries(new Map()); setExpanded(new Set()); setSelectedPath(''); setPreview(null); setError('')
    void loadDirectory('', true)
  }, [loadDirectory, sessionId])
  const toggle = (path: string) => {
    setExpanded(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next })
    if (!expanded.has(path)) void loadDirectory(path)
  }
  const select = async (path: string) => {
    setSelectedPath(path); setPreview(null); setError('')
    try { setPreview(await api.readSessionFile(sessionId, path)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '文件预览加载失败') }
  }
  const refresh = async () => {
    const paths = ['', ...expanded]
    setEntries(new Map())
    await Promise.all(paths.map(path => loadDirectory(path, true)))
    if (selectedPath) await select(selectedPath)
  }
  const crumbs = useMemo(() => selectedPath.split('/').filter(Boolean), [selectedPath])

  return <section className="flex h-full min-h-0 flex-col" aria-label="文件面板">
    <header className="flex min-h-11 items-center justify-between gap-2 border-b border-border px-3">
      <div className="min-w-0 truncate text-xs text-muted-foreground" aria-label="当前文件路径"><span className="text-foreground">workspace</span>{crumbs.map((crumb, index) => <span key={`${crumb}-${index}`}> / {crumb}</span>)}</div>
      <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label="刷新文件" onClick={() => void refresh()}><RefreshCw className="size-4" /></Button>
    </header>
    {error && <p role="alert" className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(11rem,38%)_1fr]">
      <aside className="overflow-auto border-r border-border"><FileTree state={{ entries, expanded, loading }} selectedPath={selectedPath} onToggle={toggle} onSelect={path => void select(path)} /></aside>
      <main className="min-h-0 overflow-hidden"><FilePreview path={selectedPath} file={preview} /></main>
    </div>
  </section>
}
