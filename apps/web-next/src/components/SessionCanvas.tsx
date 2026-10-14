// 会话画布：只投影服务端给出的权威图事实（节点、Fork 边与后端 revision），
// 不发领域写命令。打开、选择或拖动节点都不是 Fork，只有「从固定游标创建分支」才是。
import { useEffect, useMemo, useRef, useState } from 'react'
import { randomId, type CanvasCollaborationWatch, type CanvasCollaborationWatchOptions } from '@wemux/web-client'
import type { SessionForkPoint, SessionGraphNodeSummary, SessionGraphSnapshot } from '@wemux/web-contract/session-graph'
import type { ProjectDTO, WorkspaceDTO, WorkerDTO } from '@wemux/web-contract/browser-host'
import type { ProjectClient } from './ProjectManagement.tsx'
import { accountError, useAccountData } from './AccountForms.tsx'
import { Button, Input } from './primitives.tsx'
import { canvasNodeHeight, canvasNodeWidth, layoutSessionGraph, type CanvasLayoutEdge } from '../lib/session-canvas-layout.ts'
import { taskSessionOptions } from '../lib/task-session-options.ts'

const runtimeLabels: Record<SessionGraphNodeSummary['runtimeState'], string> = { idle: '空闲', queued: '排队中', running: '运行中', stopping: '停止中', unavailable: '不可用', failed: '失败' }
const streamLabels = { connecting: '实时：正在连接（不代表已连接）', live: '实时：已连接，血缘变更由服务端推送', stopped: '实时：权限已撤销，已停止订阅', error: '实时：订阅失败' }
type WatchCanvas = (projectId: string, options: CanvasCollaborationWatchOptions) => CanvasCollaborationWatch
type GraphState = { kind: 'loading' } | { kind: 'ready'; snapshot: SessionGraphSnapshot } | { kind: 'error'; error: string } | { kind: 'cleared' }
type LineageState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; ancestors: readonly SessionForkPoint[]; children: readonly SessionForkPoint[]; durableSeq: number } | { kind: 'error'; error: string }
type Props = {
  api: ProjectClient
  project: ProjectDTO
  /** 实时出口默认走当前账号客户端的画布订阅；测试与替代宿主可注入等价实现。 */
  collaboration?: WatchCanvas
  /** 深链带来的初始选择；只作为选择提示，可读性仍由服务端血缘读取判定。 */
  initialSessionId?: string
}
export function SessionCanvas(props: Props) {
  // 账号或团队身份变化即换一个作用域：缓存与血缘只能在原权限作用域内展示。
  const identity = props.api.taskSessionScope
  return <SessionCanvasScope key={JSON.stringify([identity?.host ?? '', identity?.account ?? '', props.project.id, props.project.accessRole])} {...props} />
}
function SessionCanvasScope({ api, project, collaboration, initialSessionId }: Props) {
  const writable = project.accessRole !== 'viewer'
  const watch = useMemo<WatchCanvas>(() => collaboration ?? ((projectId, options) => api.watchCanvasCollaboration(projectId, options)), [api, collaboration])
  const [reload, setReload] = useState(0), [streamAttempt, setStreamAttempt] = useState(0)
  const [graph, setGraph] = useState<GraphState>({ kind: 'loading' })
  const [stream, setStream] = useState<{ kind: keyof typeof streamLabels; error?: string }>({ kind: 'connecting' })
  const [cleared, setCleared] = useState(false)
  const [selected, setSelected] = useState(initialSessionId ?? '')
  const [lineage, setLineage] = useState<LineageState>({ kind: 'idle' })
  const [cursorDraft, setCursorDraft] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [open, setOpen] = useState(false)
  const [forkBusy, setForkBusy] = useState(false), [forkError, setForkError] = useState(''), [notice, setNotice] = useState('')
  const intent = useRef<{ key: string; id: string } | null>(null), inFlight = useRef(false)
  // 图与血缘各自重新读取；两者都只信服务端结果，不做本地合并。
  useEffect(() => {
    const controller = new AbortController()
    setGraph({ kind: 'loading' })
    void api.sessionGraph(project.id, {}, controller.signal).then(
      snapshot => { if (!controller.signal.aborted) { setGraph({ kind: 'ready', snapshot }); setCleared(false) } },
      cause => { if (!controller.signal.aborted) setGraph({ kind: 'error', error: accountError(cause) }) },
    )
    return () => controller.abort()
  }, [api, project.id, reload])
  useEffect(() => {
    let live = true
    setStream({ kind: 'connecting' })
    const instance = watch(project.id, { onEvent: event => {
      if (!live) return
      if (event === 'authorization') {
        // 撤权是终止状态：图、血缘与草稿一起清空，不保留任何已读取内容。
        setStream({ kind: 'stopped' }); setGraph({ kind: 'cleared' }); setLineage({ kind: 'idle' })
        setSelected(''); setCursorDraft(null); setTarget(''); setForkError(''); setNotice(''); setCleared(true); intent.current = null
        return
      }
      // 连接成功后服务端会先给一次快照；画布已由同一次授权读取，因此只更新连接状态。
      if (event === 'snapshot') setStream({ kind: 'live' })
    } })
    void instance.done.catch(cause => { if (live) setStream({ kind: 'error', error: accountError(cause) }) })
    return () => { live = false; instance.dispose() }
    // 订阅绑定在某个账号客户端上：身份或传输变化必须释放旧订阅，不把旧权限的推送带进新作用域。
  }, [api, watch, project.id, streamAttempt])
  useEffect(() => {
    setOpen(false); setForkError('')
    if (!selected) { setLineage({ kind: 'idle' }); return }
    const controller = new AbortController()
    setLineage({ kind: 'loading' }); setCursorDraft(null)
    void Promise.all([api.sessionLineage(selected, controller.signal), api.getSession(selected, controller.signal)]).then(
      ([value, session]) => { if (!controller.signal.aborted) setLineage({ kind: 'ready', ancestors: value.ancestors, children: value.children, durableSeq: session.freshness.contiguousSeq }) },
      cause => { if (!controller.signal.aborted) setLineage({ kind: 'error', error: accountError(cause) }) },
    )
    return () => controller.abort()
  }, [api, selected, reload])
  // 只有真的需要 Fork 时才读取执行环境；Discovery 只是选择辅助，服务端仍会重新核验。
  const resources = useAccountData<[WorkspaceDTO[], WorkerDTO[]]>(
    () => writable && selected ? Promise.all([api.workspaces(project.id, 'all'), api.workers()]) : Promise.resolve([[], []]),
    [api, project.id, writable, selected],
  )
  const options = taskSessionOptions(project.id, project.teamId, resources.data?.[0] ?? [], resources.data?.[1] ?? [])
  const option = options.find(value => value.key === target)
  const layout = useMemo(() => graph.kind === 'ready' ? layoutSessionGraph(graph.snapshot) : null, [graph])
  const visible = layout?.nodes.filter(entry => entry.node.visibility === 'visible').length ?? 0
  const restricted = (layout?.nodes.length ?? 0) - visible
  const durable = lineage.kind === 'ready' ? lineage.durableSeq : undefined
  const cursor = cursorDraft ?? (durable === undefined ? '' : String(durable))
  function refresh() { setNotice(''); setReload(value => value + 1) }
  async function fork() {
    if (!writable || inFlight.current || lineage.kind !== 'ready' || !option) return
    const cursorValue = Number(cursor)
    if (!/^\d+$/.test(cursor.trim()) || !Number.isSafeInteger(cursorValue)) { setForkError('分支点事件游标必须是非负整数。'); return }
    if (cursorValue > lineage.durableSeq) { setForkError(`分支点不能越过当前持久化上限 ${lineage.durableSeq}；服务端同样拒绝未持久化的游标。`); return }
    // requestId 与草稿内容绑定：内容不变就复用，响应丢失后的重试不会重复创建会话。
    const key = JSON.stringify([selected, cursorValue, option.workspaceId, option.workerId, option.agentKey, option.modelId])
    if (intent.current?.key !== key) intent.current = { key, id: randomId() }
    const requestId = intent.current.id
    inFlight.current = true; setForkBusy(true); setForkError(''); setNotice('')
    try {
      const result = await api.forkSession(project.id, {
        sourceSessionId: selected, sourceEventCursor: cursorValue, contextPolicy: 'through_cursor',
        targetWorkspaceId: option.workspaceId, targetWorkerId: option.workerId, targetAgentKey: option.agentKey, targetModelId: option.modelId, requestId,
      })
      intent.current = null
      setNotice(`已在固定游标 ${result.fork.sourceEventCursor} 创建分支会话：${result.fork.targetSessionId}${result.replayed ? '（服务端重放了同一请求，未重复创建）' : ''}。来源会话历史未被修改，两条会话此后各自独立执行。`)
      setReload(value => value + 1)
    } catch (cause) {
      setForkError(accountError(cause))
      setNotice('创建结果尚未核对。原请求保留同一请求标识，重试不会重复创建；请重新核验画布与血缘后再决定。')
    } finally { inFlight.current = false; setForkBusy(false) }
  }
  function edgePath(entry: CanvasLayoutEdge) {
    const x1 = entry.source.x + canvasNodeWidth, y1 = entry.source.y + canvasNodeHeight / 2
    const x2 = entry.target.x, y2 = entry.target.y + canvasNodeHeight / 2
    return `M ${x1} ${y1} C ${x1 + 40} ${y1}, ${x2 - 40} ${y2}, ${x2} ${y2}`
  }
  const kindOf = (fork: SessionForkPoint) => graph.kind === 'ready' ? graph.snapshot.nodes.find(node => node.sessionId === (fork.targetSessionId === selected ? fork.sourceSessionId : fork.targetSessionId)) : undefined
  return <section className="session-canvas" aria-label="会话画布">
    <div className="account-actions"><h3>会话画布</h3>
      <Button variant="outline" onClick={refresh}>重新核验画布与血缘</Button>
      {stream.kind !== 'live' && <Button variant="outline" onClick={() => setStreamAttempt(value => value + 1)}>重新连接实时出口</Button>}
    </div>
    <p>画布只投影服务端事实：节点是当前账号按内容权限可读的会话，边是权威 Fork 血缘。节点顺序、连线与选择不产生领域写入，拖动或打开节点都不是 Fork。</p>
    <p role="status" data-stream-status={stream.kind}>{streamLabels[stream.kind]}{stream.error ? `（${stream.error}）` : ''}</p>
    {cleared && <p role="status">已清除本地内容：图、血缘、分支草稿与选择都不再保留，重新核验与重新连接需服务端再次授权。已下载或截图带出设备的副本不在回收范围内。</p>}
    {graph.kind === 'loading' && <p role="status">正在读取画布…</p>}
    {graph.kind === 'error' && <p role="alert">无法读取画布：{graph.error}。未获权或已撤权的会话不会出现在画布上，请重新核验。</p>}
    {graph.kind === 'cleared' && <p role="status">画布内容已清空，等待重新核验。</p>}
    {layout && <>
      <p role="status">已加载 {layout.nodes.length} 个会话（{visible} 个可读，{restricted} 个仅知存在）；显示 {layout.edges.length} 条 Fork 关系。</p>
      <p className="machine" data-graph-revision>画布版本 {graph.kind === 'ready' ? graph.snapshot.revision : ''}</p>
      {graph.kind === 'ready' && typeof graph.snapshot.hiddenRelationCount === 'number' && graph.snapshot.hiddenRelationCount > 0 && <p>另有 {graph.snapshot.hiddenRelationCount} 条关系因权限未显示；一端的会话不可读时，关系整体不出现在画布、血缘列表与边详情中。</p>}
      {!layout.nodes.length && <p>当前账号在此项目没有可读的会话，画布不会用占位内容代替未获权的会话。</p>}
      <div className="canvas-scroll"><div className="canvas-surface" style={{ width: layout.width, height: layout.height }}>
        <svg className="canvas-edges" width={layout.width} height={layout.height} aria-hidden="true">
          {layout.edges.map(entry => <path key={entry.edge.key} data-edge-key={entry.edge.key} d={edgePath(entry)} className="canvas-edge" />)}
        </svg>
        {layout.nodes.map(entry => entry.node.visibility === 'visible' && entry.node.summary
          ? <button key={entry.node.sessionId} type="button" data-session-id={entry.node.sessionId} data-visibility="visible" className="canvas-node" style={{ left: entry.x, top: entry.y }} aria-pressed={selected === entry.node.sessionId} onClick={() => setSelected(entry.node.sessionId)}>
            <strong>{entry.node.summary.title}</strong>
            <span>运行状态：{runtimeLabels[entry.node.summary.runtimeState]}；可读分支：{entry.node.summary.branchCount}</span>
            <span>Agent：{entry.node.summary.agentKey} / Model：{entry.node.summary.modelId ?? 'Agent 默认'}</span>
            <span>{entry.node.summary.lastActivityAt ? `最近持久化活动：${entry.node.summary.lastActivityAt}` : '尚无持久化活动'}</span>
            <span>{entry.node.sessionId === selected ? '已选择，下方显示血缘与 Fork 草稿' : '选择以查看血缘'}</span>
          </button>
          : <div key={entry.node.sessionId} data-session-id={entry.node.sessionId} data-visibility="placeholder" className="canvas-node canvas-node-restricted" style={{ left: entry.x, top: entry.y }}>受限会话</div>)}
      </div></div>
      {!!layout.edges.length && <ul aria-label="可见 Fork 关系">{layout.edges.map(entry => <li key={entry.edge.key}>
        Fork {entry.edge.relation.type === 'fork' ? entry.edge.relation.forkId : ''}：{entry.source.node.visibility === 'visible' ? entry.source.node.summary?.title : '受限会话'} → {entry.target.node.visibility === 'visible' ? entry.target.node.summary?.title : '受限会话'}
      </li>)}</ul>}
    </>}
    {!writable && <p role="status">当前为只读项目角色，只读成员不能创建分支。可以查看可读节点、Fork 边与血缘。</p>}
    {selected && <section aria-label="所选会话血缘" data-lineage>
      <h4>所选会话：{sessionLabel(selected, graph)}</h4>
      <p className="machine">{selected}</p>
      {lineage.kind === 'loading' && <p role="status">正在读取血缘…</p>}
      {lineage.kind === 'error' && <p role="alert">无法读取血缘：{lineage.error}</p>}
      {lineage.kind === 'ready' && <>
        <p>来源：{lineage.ancestors.length} 个；子分支：{lineage.children.length} 个</p>
        <div className="account-actions"><Button variant="outline" aria-expanded={open} onClick={() => setOpen(value => !value)}>血缘详情{open ? '（已展开）' : '（需展开查看）'}</Button></div>
        {open && <><h5>来源（由近及远）</h5>{!lineage.ancestors.length && <p>这是当前看到的血缘起点，没有更早的 Fork 来源。</p>}<ul>{lineage.ancestors.map(fork => <li key={fork.forkId}><p>Fork {fork.forkId}：{fork.sourceSessionId} → {fork.targetSessionId}</p><p>分支点游标：{fork.sourceEventCursor}（固定，之后的消息不进入目标上下文）</p><Button variant="outline" onClick={() => setSelected(fork.sourceSessionId === selected ? fork.targetSessionId : fork.sourceSessionId)}>查看另一端会话</Button></li>)}</ul>
          <h5>子分支</h5>{!lineage.children.length && <p>还没有从本会话分出的会话。</p>}<ul>{lineage.children.map(fork => <li key={fork.forkId} data-child-fork={fork.forkId}><p>Fork {fork.forkId}：{fork.sourceSessionId} → {fork.targetSessionId}</p><p>分支点游标：{fork.sourceEventCursor}；{kindOf(fork)?.visibility === 'placeholder' ? '目标会话当前不可读，不显示标题' : '目标会话可读'}</p><Button variant="outline" onClick={() => setSelected(fork.targetSessionId)}>查看分支会话</Button></li>)}</ul></>}
        {writable
          ? <form className="account-form" aria-label="从固定游标创建分支" onSubmit={event => { event.preventDefault(); void fork() }}><fieldset disabled={forkBusy}>
            <p>从固定游标分支：目标会话拥有独立的 Journal 与后续上下文，来源游标之后的消息不会进入目标；来源会话历史保持不变。</p>
            <p>此会话当前持久化到游标 {lineage.durableSeq}，Fork 必须在已持久化的游标上创建。</p>
            <label>分支点事件游标<Input aria-label="分支点事件游标" inputMode="numeric" value={cursor} required onChange={event => setCursorDraft(event.target.value)} /></label>
            <label>目标执行环境<select aria-label="目标执行环境" value={target} required onChange={event => setTarget(event.target.value)}><option value="">选择 Workspace / Worker / Agent / Model</option>{options.map(value => <option key={value.key} value={value.key}>{value.label}</option>)}</select></label>
            {option && <p>已选择：{option.label}。目标落点独立于来源，Placement 是否可执行仍由服务端核验。</p>}
            {resources.data && !options.length && <p>没有可用执行环境。需要同项目未删除的 Workspace、已就绪 Placement、在线 Worker、可执行 Agent 和已上报的具体 Model。</p>}
            <Button type="submit" disabled={forkBusy || !option}>创建分支</Button>
          </fieldset></form>
          : <p>只读成员不能创建分支。</p>}
      </>}
    </section>}
    {selected && lineage.kind === 'ready' && resources.feedback}
    {forkBusy && <p role="status">正在创建分支会话…</p>}
    {forkError && <p role="alert">{forkError}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
/** 节点标题只来自可读摘要；受限节点一律不显示标题。 */
function sessionLabel(sessionId: string, graph: GraphState) {
  if (graph.kind !== 'ready') return sessionId
  const node = graph.snapshot.nodes.find(value => value.sessionId === sessionId)
  return node?.visibility === 'visible' ? node.summary?.title : sessionId
}
