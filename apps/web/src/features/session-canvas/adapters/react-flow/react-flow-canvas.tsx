import {
  ConnectionMode,
  MarkerType,
  MiniMap,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node as FlowNode,
  type NodeProps,
  type OnMoveEnd,
  type Viewport,
} from '@xyflow/react'
import { Copy, ExternalLink, GitBranch, LockKeyhole, Maximize2, MessageSquareText } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Api } from '../../../../api/client.ts'
import type { SessionDTO } from '../../../../api/dto.ts'
import { Canvas as AiCanvas } from '../../../../components/ai-elements/canvas.tsx'
import { Controls } from '../../../../components/ai-elements/controls.tsx'
import { Edge as AiEdge } from '../../../../components/ai-elements/edge.tsx'
import { Node, NodeAction, NodeContent, NodeDescription, NodeFooter, NodeHeader, NodeTitle } from '../../../../components/ai-elements/node.tsx'
import { Panel } from '../../../../components/ai-elements/panel.tsx'
import { Toolbar } from '../../../../components/ai-elements/toolbar.tsx'
import { Badge } from '../../../../components/ui/badge.tsx'
import { Button } from '../../../../components/ui/button.tsx'
import { formatRelativeTime, runtimeStateLabel } from '../../../../lib/display.ts'
import { cn, copyText, selectElementText } from '../../../../lib/utils.ts'
import { SessionSurface } from '../../../sessions/session-surface.tsx'
import type { CanvasSessionMode } from '../../session-surface-preference.ts'
import type { SessionCanvasProjection, SessionCanvasProjectionNode } from '../../model/session-canvas-projection.ts'

interface VisibleNodeData extends Record<string, unknown> {
  readonly kind: 'visible'
  readonly summary: NonNullable<SessionCanvasProjectionNode['summary']>
  readonly selected: boolean
  readonly interactive: boolean
  readonly handles: { readonly target: boolean; readonly source: boolean }
  readonly forkSummary: string
  readonly api: Api
  readonly projectId: string
  readonly onSelect: (sessionId: string) => void
  readonly onOpen: (sessionId: string) => void
  readonly onActivate: (sessionId: string) => void
  readonly onSetMode: (sessionId: string, mode: CanvasSessionMode) => void
}

interface PlaceholderNodeData extends Record<string, unknown> {
  readonly kind: 'placeholder'
  readonly handles: { readonly target: boolean; readonly source: boolean }
}

type SessionNodeData = VisibleNodeData | PlaceholderNodeData
type SessionFlowNode = FlowNode<SessionNodeData, 'session'>
type ForkEdgeMode = 'default' | 'animated' | 'temporary'
type SessionFlowEdge = Edge<{ readonly forkId: string; readonly mode: ForkEdgeMode }, 'fork'>
type CanvasFilter = 'all' | 'active' | 'fork'

export interface SessionCanvasChange {
  readonly nodePositions: Readonly<Record<string, { readonly x: number; readonly y: number }>>
  readonly viewport: Viewport
}

export function ReactFlowCanvas(props: { api: Api; projectId: string; projection: SessionCanvasProjection; initialViewport?: Viewport; interactiveSessionId: string; onSelect: (sessionId: string) => void; onOpen: (sessionId: string) => void; onActivate: (sessionId: string) => void; onSetMode: (sessionId: string, mode: CanvasSessionMode) => void; onChange: (change: SessionCanvasChange) => void }) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>
}

function Canvas({ api, projectId, projection, initialViewport, interactiveSessionId, onSelect, onOpen, onActivate, onSetMode, onChange }: { api: Api; projectId: string; projection: SessionCanvasProjection; initialViewport?: Viewport; interactiveSessionId: string; onSelect: (sessionId: string) => void; onOpen: (sessionId: string) => void; onActivate: (sessionId: string) => void; onSetMode: (sessionId: string, mode: CanvasSessionMode) => void; onChange: (change: SessionCanvasChange) => void }) {
  const flow = useReactFlow<SessionFlowNode, SessionFlowEdge>()
  const [filter, setFilter] = useState<CanvasFilter>('all')
  const currentViewport = useRef<Viewport>(initialViewport ?? { x: 0, y: 0, zoom: 1 })
  const visibleSessionIds = useMemo(() => filteredSessionIds(projection, filter, interactiveSessionId), [filter, interactiveSessionId, projection])
  const mappedNodes = useMemo(() => mapNodes(api, projectId, projection, interactiveSessionId, visibleSessionIds, onSelect, onOpen, onActivate, onSetMode), [api, interactiveSessionId, onActivate, onOpen, onSelect, onSetMode, projectId, projection, visibleSessionIds])
  const mappedEdges = useMemo(() => mapEdges(projection).filter(edge => visibleSessionIds.has(edge.source) && visibleSessionIds.has(edge.target)), [projection, visibleSessionIds])
  const [nodes, setNodes, onNodesChange] = useNodesState<SessionFlowNode>(mappedNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<SessionFlowEdge>(mappedEdges)

  useEffect(() => { setNodes(mappedNodes); setEdges(mappedEdges) }, [mappedNodes, mappedEdges, setNodes, setEdges])
  const publish = useCallback((viewport = currentViewport.current) => {
    const nodePositions = Object.fromEntries(projection.nodes.map(node => [node.sessionId, node.position]))
    for (const node of flow.getNodes()) nodePositions[node.id] = { x: node.position.x, y: node.position.y }
    onChange({ nodePositions, viewport })
  }, [flow, onChange, projection.nodes])
  const moved: OnMoveEnd = useCallback((_event, viewport) => { currentViewport.current = viewport; publish(viewport) }, [publish])

  return <div className="session-canvas-viewport" data-testid="session-canvas-viewport">
    <AiCanvas<SessionFlowNode, SessionFlowEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_event, node) => { if (node.data.kind === 'visible') { if (node.selected) onActivate(node.id); else onSelect(node.id) } }}
      onNodeDoubleClick={(_event, node) => { if (node.data.kind === 'visible') onActivate(node.id) }}
      onNodeDragStop={() => publish()}
      onMoveEnd={moved}
      defaultViewport={initialViewport}
      fitView={!initialViewport}
      fitViewOptions={{ padding: 0.24, maxZoom: 1.05 }}
      minZoom={0.35}
      maxZoom={1.7}
      nodesFocusable
      edgesFocusable
      elementsSelectable
      panOnDrag={[1, 2]}
      zoomOnPinch
      zoomOnScroll={false}
      onlyRenderVisibleElements
      connectionMode={ConnectionMode.Loose}
      nodesConnectable={false}
      aria-label="Session 血缘交互画布"
      proOptions={{ hideAttribution: true }}
    >
      <Controls showInteractive={false} position="bottom-left" />
      <Panel position="top-right" aria-label="画布过滤器">
        <div className="flex items-center gap-1" role="group" aria-label="过滤会话">
          {([['all', '全部'], ['active', '仅活跃'], ['fork', '仅 Fork']] as const).map(([value, label]) => <Button key={value} size="xs" variant={filter === value ? 'secondary' : 'ghost'} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</Button>)}
        </div>
      </Panel>
      <MiniMap<SessionFlowNode> pannable zoomable position="bottom-right" nodeBorderRadius={10} nodeColor={node => node.data.kind === 'placeholder' ? '#374151' : node.selected ? '#3758f9' : '#1f2937'} maskColor="rgb(3 7 18 / 0.72)" ariaLabel="会话画布缩略图" />
    </AiCanvas>
  </div>
}

const nodeTypes = { session: SessionNode }
const edgeTypes = { fork: ForkEdge }

function ForkEdge(props: EdgeProps<SessionFlowEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected, data } = props
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const style = { strokeWidth: selected ? 2 : 1.5 }
  return <>
    {data?.mode === 'animated' ? <AiEdge.Animated {...props} style={style} /> : data?.mode === 'temporary' ? <AiEdge.Temporary {...props} style={style} /> : <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />}
    <EdgeLabelRenderer><span className="nodrag nopan rounded-full border border-border bg-background/95 px-2 py-1 text-[10px] text-muted-foreground shadow-sm" style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'none' }} title={`Fork ${data?.forkId ?? id}`}>Fork · {data?.forkId ?? id}</span></EdgeLabelRenderer>
  </>
}

function SessionNode({ id, data, selected }: NodeProps<SessionFlowNode>) {
  const [hovered, setHovered] = useState(false)
  const [copyHint, setCopyHint] = useState('')
  const idRef = useRef<HTMLSpanElement>(null)
  if (data.kind === 'placeholder') return <Node handles={data.handles} className="session-flow-node-placeholder nodrag nowheel"><NodeContent className="flex items-start gap-3"><LockKeyhole className="mt-0.5 size-4 shrink-0" /><div><strong>受限会话</strong><p>你可以知道这条分支存在，但无权读取内容。</p></div></NodeContent></Node>
  const summary = data.summary
  if (data.selected && data.interactive) return <div className="session-flow-node session-flow-node-selected session-flow-node-interactive nodrag nopan nowheel"><Node handles={data.handles} className="min-h-144 w-full border-0 bg-transparent p-0 shadow-none"><button type="button" className="session-surface-collapse nodrag nopan" onClick={() => data.onSetMode(id, 'canvas-summary')}>收起为摘要</button><SessionSurface api={data.api} session={sessionFromSummary(data.projectId, id, summary)} presentation="canvas-interactive" projectPath={data.projectId} workerLabel={summary.workerId} onOpenFocus={() => { window.location.href = `/projects/${encodeURIComponent(data.projectId)}/sessions/${encodeURIComponent(id)}?from=canvas` }} /></Node></div>
  const showToolbar = hovered || selected || data.selected
  const copyId = () => void (async () => {
    if (await copyText(id)) { setCopyHint('已复制'); window.setTimeout(() => setCopyHint(''), 1600); return }
    if (idRef.current) selectElementText(idRef.current)
    setCopyHint('已选中，请按 Ctrl+C 或长按复制')
  })()
  return <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
    <Toolbar isVisible={showToolbar}>
      <Button size="xs" variant="ghost" onClick={() => data.onActivate(id)}><Maximize2 className="size-3.5" />展开对话</Button>
      <Button size="xs" variant="ghost" onClick={() => data.onOpen(id)}><ExternalLink className="size-3.5" />打开专注会话</Button>
      <Button size="xs" variant="ghost" title={copyHint || '复制会话 ID'} onClick={copyId}><Copy className="size-3.5" />{copyHint || '复制会话 ID'}</Button>
    </Toolbar>
    <Node handles={data.handles} className={cn('session-flow-node-semantic transition-colors', (selected || data.selected) && 'session-flow-node-selected')} onClick={() => data.onSelect(id)}>
      <NodeHeader>
        <div className="flex min-w-0 items-start gap-2 pr-9"><StatusBadge state={summary.runtimeState} /><NodeTitle className="min-w-0 flex-1 truncate">{summary.title}</NodeTitle></div>
        <NodeDescription className="truncate">{summary.agentKey} · {summary.modelId ?? '默认模型'} · {summary.lastActivityAt ? formatRelativeTime(summary.lastActivityAt) : '尚无持久事件'}</NodeDescription>
        <NodeAction><Button iconOnly size="icon-xs" variant="ghost" aria-label="打开专注会话" title="打开专注会话" onClick={event => { event.stopPropagation(); data.onOpen(id) }}><ExternalLink className="size-4" /></Button></NodeAction>
      </NodeHeader>
      <NodeContent className="flex items-center gap-2 text-xs text-muted-foreground"><MessageSquareText className="size-4 text-primary" /><span className="truncate">{runtimeStateLabel[summary.runtimeState]} · {summary.workspaceId}</span><span ref={idRef} className="sr-only">{id}</span></NodeContent>
      <NodeFooter className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground"><span className="flex items-center gap-1"><GitBranch className="size-3" />{summary.branchCount} 个分支</span><span className="truncate">{data.forkSummary}</span></NodeFooter>
    </Node>
  </div>
}

function StatusBadge({ state }: { state: NonNullable<SessionCanvasProjectionNode['summary']>['runtimeState'] }) {
  const tone = state === 'running' ? 'bg-emerald-500/15 text-emerald-400' : state === 'queued' || state === 'stopping' ? 'bg-amber-500/15 text-amber-300' : state === 'failed' ? 'bg-red-500/15 text-red-400' : state === 'unavailable' ? 'bg-slate-500/20 text-slate-300' : 'bg-blue-500/15 text-blue-300'
  return <Badge variant="outline" className={cn('shrink-0 border-transparent px-1.5 py-0 text-[10px]', tone)}>{runtimeStateLabel[state]}</Badge>
}

const sessionFromSummary = (projectId: string, id: string, summary: NonNullable<SessionCanvasProjectionNode['summary']>): SessionDTO => ({ id, projectId, workspaceId: summary.workspaceId, workerId: summary.workerId, agentKey: summary.agentKey, modelId: summary.modelId, title: summary.title, runtimeState: summary.runtimeState, archivedAt: null, activeTurnId: null, queuedMessageCount: null, freshness: { status: 'unknown' }, updatedAt: summary.lastActivityAt ?? new Date(0).toISOString(), canRead: true, canSend: true, canManage: true, access: { canRead: true, canWrite: true, canControl: true, projectRole: null }, sendCapability: { allowed: true, reasonCode: 'allowed', reason: '当前成员可发送消息' } })

const activeStates = new Set(['queued', 'running', 'stopping'])
const filteredSessionIds = (projection: SessionCanvasProjection, filter: CanvasFilter, interactiveSessionId: string): Set<string> => {
  const forked = new Set(projection.edges.flatMap(edge => [edge.sourceSessionId, edge.targetSessionId]))
  return new Set(projection.nodes.filter(node => node.sessionId === interactiveSessionId || filter === 'all' || (filter === 'fork' && forked.has(node.sessionId)) || (filter === 'active' && node.visibility === 'visible' && activeStates.has(node.summary!.runtimeState))).map(node => node.sessionId))
}

const mapNodes = (api: Api, projectId: string, projection: SessionCanvasProjection, interactiveSessionId: string, visibleSessionIds: ReadonlySet<string>, onSelect: (sessionId: string) => void, onOpen: (sessionId: string) => void, onActivate: (sessionId: string) => void, onSetMode: (sessionId: string, mode: CanvasSessionMode) => void): SessionFlowNode[] => {
  const incoming = new Set(projection.edges.map(edge => edge.targetSessionId))
  const outgoing = new Set(projection.edges.map(edge => edge.sourceSessionId))
  const parentForks = new Map<string, string[]>()
  for (const edge of projection.edges) parentForks.set(edge.targetSessionId, [...(parentForks.get(edge.targetSessionId) ?? []), edge.forkId])
  return projection.nodes.filter(node => visibleSessionIds.has(node.sessionId)).map(node => {
    const handles = { target: incoming.has(node.sessionId), source: outgoing.has(node.sessionId) }
    return {
      id: node.sessionId,
      type: 'session',
      position: node.position,
      draggable: node.sessionId !== interactiveSessionId,
      selected: node.sessionId === interactiveSessionId ? true : undefined,
      deletable: false,
      data: node.visibility === 'visible'
        ? { kind: 'visible', summary: node.summary!, selected: node.selected || node.sessionId === interactiveSessionId, interactive: node.sessionId === interactiveSessionId, handles, forkSummary: parentForks.has(node.sessionId) ? `来自 ${parentForks.get(node.sessionId)!.join('、')}` : node.summary!.branchCount > 0 ? 'Fork 起点' : '主会话', api, projectId, onSelect, onOpen, onActivate, onSetMode }
        : { kind: 'placeholder', handles },
      ariaLabel: node.visibility === 'visible' ? `会话：${node.summary!.title}` : '受限会话',
    }
  })
}

const mapEdges = (projection: SessionCanvasProjection): SessionFlowEdge[] => {
  const summaries = new Map<string, NonNullable<SessionCanvasProjectionNode['summary']>>(projection.nodes.filter(node => node.visibility === 'visible').map(node => [String(node.sessionId), node.summary!]))
  return projection.edges.map(edge => {
    const sourceState = summaries.get(edge.sourceSessionId)?.runtimeState
    const targetState = summaries.get(edge.targetSessionId)?.runtimeState
    const mode: ForkEdgeMode = sourceState === 'failed' || sourceState === 'unavailable' || sourceState === 'stopping' || targetState === 'failed' || targetState === 'unavailable' || targetState === 'stopping' ? 'temporary' : targetState === 'running' || targetState === 'queued' ? 'animated' : 'default'
    return { id: edge.key, type: 'fork', source: edge.sourceSessionId, target: edge.targetSessionId, data: { forkId: edge.forkId, mode }, label: `Fork · ${edge.forkId}`, ariaLabel: `从 ${edge.sourceSessionId} 分支到 ${edge.targetSessionId}`, markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 }, style: { strokeWidth: 1.5 } }
  })
}
