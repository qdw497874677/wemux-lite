import '@xyflow/react/dist/style.css'
import {
  Background,
  BackgroundVariant,
  Controls,
  ConnectionMode,
  Handle,
  MarkerType,
  MiniMap,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type OnMoveEnd,
  type Viewport,
} from '@xyflow/react'
import { GitBranch, LockKeyhole, MessageSquareText } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { Api } from '../../../../api/client.ts'
import { Badge } from '../../../../components/ui/badge.tsx'
import { cn } from '../../../../lib/utils.ts'
import { formatChineseTime, runtimeStateLabel } from '../../../../lib/display.ts'
import { SessionSurface } from '../../../sessions/session-surface.tsx'
import type { CanvasSessionMode } from '../../session-surface-preference.ts'
import type { SessionCanvasProjection, SessionCanvasProjectionNode } from '../../model/session-canvas-projection.ts'
import type { SessionDTO } from '../../../../api/dto.ts'

interface VisibleNodeData extends Record<string, unknown> {
  readonly kind: 'visible'
  readonly summary: NonNullable<SessionCanvasProjectionNode['summary']>
  readonly selected: boolean
  readonly interactive: boolean
  readonly api: Api
  readonly projectId: string
  readonly onSelect: (sessionId: string) => void
  readonly onOpen: (sessionId: string) => void
  readonly onActivate: (sessionId: string) => void
  readonly onSetMode: (sessionId: string, mode: CanvasSessionMode) => void
}

interface PlaceholderNodeData extends Record<string, unknown> {
  readonly kind: 'placeholder'
}

type SessionNodeData = VisibleNodeData | PlaceholderNodeData
type SessionFlowNode = Node<SessionNodeData, 'session'>
type SessionFlowEdge = Edge<{ readonly forkId: string }, 'fork'>

export interface SessionCanvasChange {
  readonly nodePositions: Readonly<Record<string, { readonly x: number; readonly y: number }>>
  readonly viewport: Viewport
}

export function ReactFlowCanvas(props: { api: Api; projectId: string; projection: SessionCanvasProjection; initialViewport?: Viewport; interactiveSessionId: string; onSelect: (sessionId: string) => void; onOpen: (sessionId: string) => void; onActivate: (sessionId: string) => void; onSetMode: (sessionId: string, mode: CanvasSessionMode) => void; onChange: (change: SessionCanvasChange) => void }) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>
}

function Canvas({ api, projectId, projection, initialViewport, interactiveSessionId, onSelect, onOpen, onActivate, onSetMode, onChange }: { api: Api; projectId: string; projection: SessionCanvasProjection; initialViewport?: Viewport; interactiveSessionId: string; onSelect: (sessionId: string) => void; onOpen: (sessionId: string) => void; onActivate: (sessionId: string) => void; onSetMode: (sessionId: string, mode: CanvasSessionMode) => void; onChange: (change: SessionCanvasChange) => void }) {
  const flow = useReactFlow<SessionFlowNode, SessionFlowEdge>()
  const currentViewport = useRef<Viewport>(initialViewport ?? { x: 0, y: 0, zoom: 1 })
  const mappedNodes = useMemo(() => mapNodes(api, projectId, projection, interactiveSessionId, onSelect, onOpen, onActivate, onSetMode), [api, interactiveSessionId, onActivate, onOpen, onSelect, onSetMode, projectId, projection])
  const mappedEdges = useMemo(() => mapEdges(projection), [projection])
  const [nodes, setNodes, onNodesChange] = useNodesState<SessionFlowNode>(mappedNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<SessionFlowEdge>(mappedEdges)

  useEffect(() => { setNodes(mappedNodes); setEdges(mappedEdges) }, [mappedNodes, mappedEdges, setNodes, setEdges])
  const publish = useCallback((viewport = currentViewport.current) => {
    onChange({ nodePositions: Object.fromEntries(flow.getNodes().map(node => [node.id, { x: node.position.x, y: node.position.y }])), viewport })
  }, [flow, onChange])
  const moved: OnMoveEnd = useCallback((_event, viewport) => { currentViewport.current = viewport; publish(viewport) }, [publish])

  return <div className="session-canvas-viewport" data-testid="session-canvas-viewport">
    <ReactFlow<SessionFlowNode, SessionFlowEdge>
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
      selectionOnDrag
      panOnDrag={[1, 2]}
      panOnScroll
      zoomOnPinch
      zoomOnScroll={false}
      onlyRenderVisibleElements
      deleteKeyCode={null}
      connectionMode={ConnectionMode.Loose}
      nodesConnectable={false}
      aria-label="Session 血缘交互画布"
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap<SessionFlowNode> pannable zoomable position="bottom-right" nodeBorderRadius={10} nodeColor={node => node.data.kind === 'placeholder' ? '#374151' : node.selected ? '#3758f9' : '#1f2937'} maskColor="rgb(3 7 18 / 0.72)" ariaLabel="会话画布缩略图" />
    </ReactFlow>
  </div>
}

const nodeTypes = { session: SessionNode }
const edgeTypes = { fork: ForkEdge }

function ForkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected, data }: EdgeProps<SessionFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ strokeWidth: selected ? 2 : 1.5 }} />
    <EdgeLabelRenderer><button type="button" className="nodrag nopan rounded-full border border-border bg-background/95 px-2 py-1 text-[10px] text-muted-foreground shadow-sm hover:border-primary/60 hover:text-foreground" style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all' }} title={`Fork ${data?.forkId ?? id}`}>Fork · {data?.forkId ?? id}</button></EdgeLabelRenderer>
  </>
}

function SessionNode({ id, data, selected }: NodeProps<SessionFlowNode>) {
  if (data.kind === 'placeholder') return <div className="session-flow-node session-flow-node-placeholder nodrag nowheel"><Handle type="target" position={Position.Left} isConnectable={false} /><LockKeyhole className="size-4" /><div><strong>受限会话</strong><p>你可以知道这条分支存在，但无权读取内容。</p></div></div>
  const summary = data.summary
  if (data.selected && data.interactive) return <div className="session-flow-node session-flow-node-selected session-flow-node-interactive nodrag nopan nowheel"><Handle type="target" position={Position.Left} isConnectable={false} /><button type="button" className="session-surface-collapse nodrag nopan" onClick={() => data.onSetMode(id, 'canvas-summary')}>收起为摘要</button><SessionSurface api={data.api} session={sessionFromSummary(data.projectId, id, summary)} presentation="canvas-interactive" projectPath={data.projectId} workerLabel={summary.workerId} onOpenFocus={() => { window.location.href = `/projects/${encodeURIComponent(data.projectId)}/sessions/${encodeURIComponent(id)}?from=canvas` }} /><Handle type="source" position={Position.Right} isConnectable={false} /></div>
  return <div className={cn('session-flow-node', (selected || data.selected) && 'session-flow-node-selected')} onClick={() => data.onSelect(id)}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <div className="flex items-start gap-3"><span className="session-canvas-node-icon"><MessageSquareText className="size-4" /></span><div className="min-w-0 flex-1"><strong className="block truncate text-sm">{summary.title}</strong><p className="mt-1 truncate text-xs text-muted-foreground">{summary.agentKey} · {summary.modelId ?? '默认模型'}</p></div><Badge variant={summary.runtimeState === 'running' ? 'success' : 'outline'}>{runtimeStateLabel[summary.runtimeState]}</Badge></div>
    <div className="mt-4 flex items-center justify-between gap-3 border-t border-border/70 pt-3 text-[11px] text-muted-foreground"><span>{summary.lastActivityAt ? formatChineseTime(summary.lastActivityAt) : '尚无持久事件'}</span><span className="flex items-center gap-1"><GitBranch className="size-3" />{summary.branchCount} 个分支</span></div>
    <div className="nodrag nopan nowheel mt-3 grid grid-cols-2 gap-2"><button type="button" className="rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-accent" onClick={event => { event.stopPropagation(); data.onActivate(id) }}>展开对话</button><button type="button" className="rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-accent" onClick={event => { event.stopPropagation(); data.onOpen(id) }}>打开专注会话</button></div>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>
}

const sessionFromSummary = (projectId: string, id: string, summary: NonNullable<SessionCanvasProjectionNode['summary']>): SessionDTO => ({ id, projectId, workspaceId: summary.workspaceId, workerId: summary.workerId, agentKey: summary.agentKey, modelId: summary.modelId, title: summary.title, runtimeState: summary.runtimeState, archivedAt: null, activeTurnId: null, queuedMessageCount: null, freshness: { status: 'unknown' }, updatedAt: summary.lastActivityAt ?? new Date(0).toISOString(), canRead: true, canSend: true, canManage: true, access: { canRead: true, canWrite: true, canControl: true, projectRole: null }, sendCapability: { allowed: true, reasonCode: 'allowed', reason: '当前成员可发送消息' } })

const mapNodes = (api: Api, projectId: string, projection: SessionCanvasProjection, interactiveSessionId: string, onSelect: (sessionId: string) => void, onOpen: (sessionId: string) => void, onActivate: (sessionId: string) => void, onSetMode: (sessionId: string, mode: CanvasSessionMode) => void): SessionFlowNode[] => projection.nodes.map(node => ({
  id: node.sessionId,
  type: 'session',
  position: node.position,
  draggable: node.sessionId !== interactiveSessionId,
  selected: node.sessionId === interactiveSessionId ? true : undefined,
  deletable: false,
  data: node.visibility === 'visible'
    ? { kind: 'visible', summary: node.summary!, selected: node.selected || node.sessionId === interactiveSessionId, interactive: node.sessionId === interactiveSessionId, api, projectId, onSelect, onOpen, onActivate, onSetMode }
    : { kind: 'placeholder' },
  ariaLabel: node.visibility === 'visible' ? `会话：${node.summary!.title}` : '受限会话',
}))

const mapEdges = (projection: SessionCanvasProjection): SessionFlowEdge[] => projection.edges.map(edge => ({
  id: edge.key,
  type: 'fork',
  source: edge.sourceSessionId,
  target: edge.targetSessionId,
  data: { forkId: edge.forkId },
  label: `Fork · ${edge.forkId}`,
  ariaLabel: `从 ${edge.sourceSessionId} 分支到 ${edge.targetSessionId}`,
  markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
  style: { strokeWidth: 1.5 },
  labelStyle: { fontSize: 10, fill: 'var(--muted-foreground)' },
  labelBgStyle: { fill: 'var(--background)', fillOpacity: 0.88 },
}))
