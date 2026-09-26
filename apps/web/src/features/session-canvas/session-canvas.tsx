import type { SessionGraphSnapshot } from '@wemux/web-contract/session-graph'
import { LockKeyhole, Network, Workflow } from 'lucide-react'
import type { Api } from '../../api/client.ts'
import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Badge } from '../../components/ui/badge.tsx'
import { ApiError } from '../../api/client.ts'
import { Button } from '../../components/ui/button.tsx'
import { readCanvasViewState, writeCanvasViewState } from './application/canvas-layout-store.ts'
import { readPreferredCanvasLayout, saveCanvasLayout } from './application/canvas-layouts.ts'
import { projectSessionGraph } from './model/session-canvas-projection.ts'
import { ReactFlowCanvas, type SessionCanvasChange } from './adapters/react-flow/react-flow-canvas.tsx'
import { getCanvasSessionMode, setCanvasSessionMode, type CanvasSessionMode } from './session-surface-preference.ts'
import { useCanvasCollaboration } from './use-canvas-collaboration.ts'

export function SessionCanvas({ api, projectId, graph, selectedSessionId, interactiveSessionId, onSelect, onOpen, onActivate, loading = false, error = '', onRetry }: { api: Api; projectId: string; graph: SessionGraphSnapshot | null; selectedSessionId: string; interactiveSessionId: string; onSelect: (sessionId: string) => void; onOpen: (sessionId: string) => void; onActivate: (sessionId: string) => void; loading?: boolean; error?: string; onRetry?: () => void }) {
  const localSaved = useMemo(() => graph ? readCanvasViewState(projectId, graph.revision) : null, [projectId, graph])
  const [serverSaved, setServerSaved] = useState<typeof localSaved>(null)
  const [layoutStatus, setLayoutStatus] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'conflict' | 'local'>('loading')
  const saved = serverSaved ?? localSaved
  const [sessionModes, setSessionModes] = useState<Record<string, CanvasSessionMode>>({})
  const preferredMode = selectedSessionId ? sessionModes[selectedSessionId] ?? getCanvasSessionMode(projectId, selectedSessionId) : 'canvas-summary'
  const activeInteractiveSessionId = selectedSessionId && preferredMode !== 'canvas-summary' ? interactiveSessionId : ''
  const projection = useMemo(() => graph ? projectSessionGraph(graph, selectedSessionId, saved?.nodePositions) : null, [graph, saved, selectedSessionId])
  const collaboration = useCanvasCollaboration(api, projectId, selectedSessionId || null)
  const [rendererFailed, setRendererFailed] = useState(false)
  useEffect(() => { setRendererFailed(false) }, [graph?.revision])
  useEffect(() => {
    if (!graph) return
    const currentGraph = graph
    const controller = new AbortController()
    setLayoutStatus('loading')
    void readPreferredCanvasLayout(api, projectId, controller.signal).then(layout => {
      if (!layout || layout.graphRevision !== currentGraph.revision) { setServerSaved(null); setLayoutStatus('ready'); return }
      setServerSaved({ graphRevision: layout.graphRevision, nodePositions: layout.nodePositions, viewport: layout.viewport })
      setLayoutStatus('ready')
    }).catch(() => { if (!controller.signal.aborted) setLayoutStatus('local') })
    return () => controller.abort()
  }, [api, graph?.revision, projectId])
  const persist = useCallback((change: SessionCanvasChange) => {
    if (!graph) return
    const state = { graphRevision: graph.revision, ...change }
    try { writeCanvasViewState(projectId, state) } catch { /* Local layout is optional; lineage and Session routes stay usable. */ }
    setServerSaved(state); setLayoutStatus('saving')
    void saveCanvasLayout(api, projectId, 'personal', graph.revision, change.nodePositions, change.viewport).then(() => setLayoutStatus('saved')).catch(error => setLayoutStatus(error instanceof ApiError && error.status === 409 ? 'conflict' : 'local'))
  }, [api, graph, projectId])

  if (loading && !graph) return <CanvasState title="正在加载会话画布" detail="正在读取 Server 权威的 Session 与 Fork 关系。" />
  if (error && !graph) return <CanvasState title="画布暂时不可用" detail={error} action={onRetry ? <Button variant="outline" size="sm" onClick={onRetry}>重新加载</Button> : undefined} />
  if (!graph || graph.nodes.length === 0) return <CanvasState title="还没有可展示的会话" detail="创建会话后，它会出现在这里；从会话分支时会显示稳定的血缘关系。" />
  if (!projection) return null

  return <section className="session-canvas" aria-label="会话画布">
    <header className="session-canvas-header">
      <div><div className="flex items-center gap-2 text-sm font-semibold"><Network className="size-4 text-primary-400" />会话画布</div><p className="mt-1 text-xs text-muted-foreground">{projection.nodes.length} 个会话 · {projection.edges.length} 条 Fork 关系 · {layoutStatus === 'saving' ? '正在保存个人布局' : layoutStatus === 'saved' ? '个人布局已保存' : layoutStatus === 'conflict' ? '图已更新，请重新加载后再保存' : layoutStatus === 'local' ? 'Server 保存不可用，已保留本机布局' : '优先恢复个人布局，再回退团队默认布局'}</p></div>
      <div className="session-canvas-presence" aria-label="画布在线成员"><span>{collaboration.status === 'live' ? '实时协作已连接' : collaboration.status === 'reconnecting' ? '实时协作正在重连' : collaboration.status === 'unavailable' ? '实时协作暂不可用' : '正在连接实时协作'}</span>{collaboration.snapshot.presence.map(member => <span key={member.userId} className="session-canvas-presence-member" title={member.activeSessionId ? `正在查看 ${member.activeSessionId}` : '正在浏览画布'}>{member.displayName}</span>)}<Badge variant="outline">{projection.revision}</Badge></div>
    </header>
    {error && <p className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-100" role="status">显示上次成功加载的画布。{error}</p>}
    {projection.hiddenRelationCount !== null && projection.hiddenRelationCount > 0 && <p className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground"><LockKeyhole className="size-3.5" />另有 {projection.hiddenRelationCount} 条关系因权限未显示。</p>}
    {rendererFailed
      ? <CanvasFallback graph={graph} selectedSessionId={selectedSessionId} onSelect={onSelect} onOpen={onOpen} />
      : <CanvasRenderBoundary key={graph.revision} onFail={() => setRendererFailed(true)}><ReactFlowCanvas api={api} projectId={projectId} projection={projection} initialViewport={saved?.viewport} interactiveSessionId={activeInteractiveSessionId} onSelect={onSelect} onOpen={onOpen} onActivate={onActivate} onSetMode={(sessionId, mode) => { setCanvasSessionMode(projectId, sessionId, mode); setSessionModes(current => ({ ...current, [sessionId]: mode })); if (mode === 'canvas-summary') onSelect(sessionId); else { setSessionModes(current => ({ ...current, [sessionId]: 'canvas-interactive' })); onActivate(sessionId) } }} onChange={persist} /></CanvasRenderBoundary>}
  </section>
}

class CanvasRenderBoundary extends Component<{ children: ReactNode; onFail: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { this.props.onFail() }
  render() { return this.state.failed ? null : this.props.children }
}

function CanvasFallback({ graph, selectedSessionId, onSelect, onOpen }: { graph: SessionGraphSnapshot; selectedSessionId: string; onSelect: (id: string) => void; onOpen: (id: string) => void }) {
  return <div className="session-canvas-fallback" role="alert"><div><h2 className="text-sm font-semibold">交互画布加载失败</h2><p className="mt-1 text-sm text-muted-foreground">会话和专注路由仍可使用。请从下方列表继续。</p></div><div className="grid gap-2">{graph.nodes.map(node => node.visibility === 'placeholder' ? <div key={node.sessionId} className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">受限会话</div> : <div key={node.sessionId} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"><button type="button" aria-current={node.sessionId === selectedSessionId ? 'true' : undefined} className="min-w-0 truncate text-left text-sm font-medium hover:underline" onClick={() => onSelect(node.sessionId)}>{node.summary!.title}</button><Button size="sm" variant="outline" onClick={() => onOpen(node.sessionId)}>打开</Button></div>)}</div></div>
}

function CanvasState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <section className="session-canvas session-canvas-state" aria-label="会话画布"><span className="session-canvas-state-icon"><Workflow className="size-6" /></span><div><h2 className="text-sm font-semibold">{title}</h2><p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">{detail}</p>{action && <div className="mt-3">{action}</div>}</div></section>
}
