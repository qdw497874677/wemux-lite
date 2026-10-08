import { ConversationControls } from './ConversationControls.tsx'
import { ConversationComposer } from './ConversationComposer.tsx'
import { useEffect, useRef, useState } from 'react'
import { createConversationController, type ConversationController, type ConversationSnapshot, type ConversationTimelineEntry } from '@wemux/web-client'
import type { ProjectDTO } from '@wemux/web-contract/browser-host'
import type { ProjectClient } from './ProjectManagement.tsx'
import { Button } from './primitives.tsx'

const runtimeLabels = { idle: '空闲', queued: '排队中', running: '运行中', stopping: '停止中', unavailable: '不可用', failed: '失败' }
const freshnessLabels = { unknown: '尚未确认', syncing: '同步中', synced: '已同步', gap: '存在缺口', offline: 'Worker 离线', orphaned: '无法恢复' }
const statusLabels = { loading: '正在加载会话', refreshing: '正在刷新会话', ready: '已读取会话', error: '读取失败，保留上次已验证历史', blocked: '会话不可访问，已清除历史', disposed: '会话已关闭' }
const subscriptionLabels = { starting: '准备订阅', watching: '监听更新中（不代表已连接或历史完整）', closed: '订阅已关闭', error: '订阅失败', disposed: '订阅已释放' }

/** Text stays escaped, selectable and bounded on first display; no hidden truncation of available content. */
function ReadText({ text }: { text: string }) {
  const [limit, setLimit] = useState(4000)
  return <><pre>{text.slice(0, limit)}</pre>{text.length > limit && <Button variant="outline" onClick={() => setLimit(value => value + 4000)}>显示更多内容（剩余 {text.length - limit} 字符）</Button>}</>
}
/** Inspect structured tool data lazily instead of eagerly stringifying an unlimited payload. */
function ReadValue({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false), [limit, setLimit] = useState(30)
  if (value === null || typeof value !== 'object') return <ReadText text={typeof value === 'string' ? value : String(value)} />
  const keys = Object.keys(value)
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{Array.isArray(value) ? '列表' : '字段'}（{keys.length} 项）</summary>{open && <><dl>{keys.slice(0, limit).map(key => <div key={key}><dt>{key}</dt><dd><ReadValue value={(value as Record<string, unknown>)[key]} /></dd></div>)}</dl>{keys.length > limit && <Button variant="outline" onClick={() => setLimit(count => count + 30)}>显示更多字段</Button>}</>}</details>
}
function JournalEntry({ entry, snapshot }: { entry: ConversationTimelineEntry; snapshot: ConversationSnapshot }) {
  const projection = snapshot.projection
  if (entry.kind === 'unsupported') return <><h4>尚不支持的历史事件：{entry.payload.kind}</h4><ReadValue value={entry.payload} /></>
  const event = entry.payload
  switch (event.kind) {
    case 'message.queued': return <><h4>用户消息</h4><ReadText text={event.content} /></>
    case 'message.cancelled': return <p>消息已取消：{event.messageId}</p>
    case 'assistant.text.delta': {
      const segment = projection.textSegments.find(value => value.seq === entry.seq)
      return segment ? <><h4>{{ assistant_text: '助手', reasoning_text: '推理', plan_text: '计划' }[segment.streamKind]}</h4><ReadText text={segment.text} /></> : null
    }
    case 'tool.started':
    case 'tool.output.delta':
    case 'tool.finished': {
      const tool = projection.tools.find(value => value.seq === entry.seq)
      return tool ? <details className="conversation-tool"><summary>工具：{tool.toolName ?? tool.toolCallId}（{{ unknown: '状态未知', running: '执行中', completed: '已完成', failed: '失败', finished: '已结束，结果未知' }[tool.state]}）</summary><p>调用标识：{tool.toolCallId}；退出码：{tool.exitCode ?? '未知'}</p><h5>输入</h5><ReadValue value={tool.input} /><h5>输出</h5><ReadText text={tool.output || '暂无输出'} /></details> : null
    }
    case 'approval.requested': {
      const approval = projection.approvals.find(value => value.approvalId === event.approvalId && value.turnId === event.turnId)
      return <><h4>审批请求（{approval?.expired ? '已过期' : approval?.decision === 'approve' ? '已批准' : approval?.decision === 'deny' ? '已拒绝' : '尚未处理'}）</h4><p>{event.reason ?? '未提供原因'}。可操作的请求显示在工具审批区。</p><ReadValue value={event.action} /></>
    }
    case 'approval.expired': return <p>审批已失效：{event.approvalId}（{{ timeout: '等待超时', cancelled: '操作取消', turn_released: 'Turn 已释放', shutdown: 'Worker 关闭' }[event.reason]}），不代表人工拒绝。</p>
    case 'approval.resolved': return <p>审批已{event.decision === 'approve' ? '批准' : '拒绝'}：{event.approvalId}</p>
    case 'turn.started': return <p>Turn 开始：{event.turnId}；固定模型：{event.modelId === undefined ? '旧历史未记录' : event.modelId ?? 'Agent 默认模型'}</p>
    case 'turn.finished': return <><p>Turn {{ completed: '已完成', cancelled: '已取消', failed: '失败' }[event.outcome]}：{event.turnId}，不代表任务完成。</p>{event.failure && <div role="note"><p>{event.failure.code}</p><ReadText text={event.failure.message} /></div>}</>
    case 'usage.updated': return <><h4>用量记录</h4><dl>{Object.entries(event.usage).map(([key, value]) => <div key={key}><dt>{({ inputTokens: '输入 Token', outputTokens: '输出 Token', totalTokens: '总 Token', cacheReadTokens: '缓存读取 Token', cacheWriteTokens: '缓存写入 Token', costUsd: '费用（美元）', modelId: '模型', scope: '统计范围', completeness: '完整性', revision: '版本', source: '来源', subjectId: '统计对象', currency: '币种' } as Record<string, string>)[key] ?? key}</dt><dd>{String(value)}</dd></div>)}</dl></>
    case 'model.changed': return <p>模型历史：{event.previousModelId ?? '未指定'} → {event.modelId}，不追溯改变已有 Turn。</p>
    case 'runtime.notice': return <><h4>{event.level === 'warning' ? '运行警告' : '运行通知'}：{event.code}</h4><ReadText text={event.message} />{event.retry && <p>重试 {event.retry.attempt} / {event.retry.maxAttempts ?? '未知'}；等待 {event.retry.delayMs ?? '未知'} 毫秒</p>}</>
    case 'session.runtime.changed': return <p>历史运行状态：{runtimeLabels[event.state]}；{event.reason ?? '未提供原因'}</p>
    case 'compaction.started': return <p>上下文压缩开始：{event.reason ?? '未提供原因'}</p>
    case 'compaction.finished': return <><h4>上下文压缩结束</h4><ReadText text={event.summary ?? '无摘要'} /></>
  }
}
function Freshness({ value }: { value: NonNullable<ConversationSnapshot['freshness']> }) {
  return <span>{freshnessLabels[value.status]}；连续序号 {value.contiguousSeq} / Worker {value.workerLastSeq ?? '未知'}</span>
}
type Props = { api: ProjectClient; project: ProjectDTO; taskId: string; sessionId: string; close: () => void }
type Active = { api: ProjectClient; key: string; controller: ConversationController; snapshot: ConversationSnapshot }
export function SessionConversation({ api, project, taskId, sessionId, close }: Props) {
  const identity = api.taskSessionScope
  const validIdentity = !!identity.account?.trim() && !!identity.teamId?.trim() && identity.teamId === project.teamId
  const validSelection = !!sessionId.trim()
  const [attempt, setAttempt] = useState(0), [active, setActive] = useState<Active | null>(null)
  const key = JSON.stringify([identity.host, identity.account, identity.teamId, project.id, taskId, sessionId, attempt])
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (!validIdentity || !validSelection || !identity.teamId) return
    // Side effects only after commit. Each immutable host/account/team/resource lifetime owns one controller.
    const controller = createConversationController({ accountId: identity.account, teamId: identity.teamId, projectId: project.id, taskId, sessionId }, api)
    let live = true
    const update = () => { if (live) setActive({ api, key, controller, snapshot: controller.getSnapshot() }) }
    const unsubscribe = controller.subscribe(update)
    update()
    return () => { live = false; unsubscribe(); controller.dispose() }
  }, [api, key, validIdentity, validSelection, identity.account, identity.teamId, project.id, taskId, sessionId])
  useEffect(() => { heading.current?.focus() }, [api, key])
  // Guard during render as well as cleanup: an old snapshot must never flash before the new effect runs.
  const current = active?.api === api && active.key === key && validIdentity && validSelection ? active : null
  const snapshot = current?.snapshot, session = snapshot?.session
  const projection = snapshot?.projection
  const visibleEntries = projection?.timeline.filter(entry => entry.kind === 'unsupported' || (entry.payload.kind === 'assistant.text.delta' ? projection.textSegments.some(segment => segment.seq === entry.seq) : ['tool.started', 'tool.output.delta', 'tool.finished'].includes(entry.payload.kind) ? projection.tools.some(tool => tool.seq === entry.seq) : true))
  return <section className="session-conversation" aria-label="任务会话对话" data-conversation-session={sessionId}>
    <div className="account-actions"><h3 tabIndex={-1} ref={heading}>任务会话对话</h3><Button variant="outline" onClick={close}>关闭会话</Button></div>
    <p>查看获权历史，并在权威权限与发送能力允许时提交消息。可按当前权限取消排队消息或停止明确 Turn；可处理当前待决工具审批，并为后续 Turn 选择模型。</p>
    <p className="machine">所选 Session：{sessionId}</p>
    {!validIdentity ? <p role="alert">缺少当前账号或团队身份，或项目与当前团队不一致。请重新选择团队后打开会话。</p> : !validSelection ? <p role="alert">会话标识无效，请关闭后从任务会话列表重新选择。</p> : <>
      <div className="account-actions"><Button variant="outline" disabled={!current || snapshot?.status === 'blocked'} onClick={() => current?.controller.refresh()}>刷新会话历史</Button><Button variant="outline" disabled={!current} onClick={() => snapshot?.status === 'blocked' ? setAttempt(value => value + 1) : current?.controller.retry()}>重新连接并重试</Button></div>
      <p role="status">{snapshot ? statusLabels[snapshot.status] : '正在加载会话'}{snapshot?.needsRefresh ? '；需要刷新或等待下一次更新' : ''}</p>
      {snapshot && <p>更新订阅：{subscriptionLabels[snapshot.subscription]}</p>}
      {(snapshot?.error || snapshot?.subscriptionError) && <p role="alert">无法完成读取：{(snapshot.error ?? snapshot.subscriptionError)?.code}。请核实权限、会话归属和连接后重试；不会自动打开其他会话。</p>}
      {session && <section aria-label="权威会话元数据"><h4>{session.title}</h4><p>当前运行状态：{runtimeLabels[session.runtimeState]}；待执行消息：{session.queuedMessages.length}；当前 Turn：{session.activeTurnId ?? '无'}</p><p>Workspace：{session.workspaceId} / Worker：{session.binding.agent.workerId} / Agent：{session.binding.agent.agentKey} / 当前 Model：{session.binding.modelId ?? '未指定'}</p><p>元数据新鲜度：<Freshness value={session.freshness} /></p><p>{session.archivedAt ? '已归档；' : ''}{session.access.canWrite ? '拥有写权限，发送仍需核验当前发送能力。' : '只读权限。'}</p></section>}
      <ConversationControls api={api} scope={{ host: identity.host, accountId: api.controlIdentity.accountId ?? '', teamId: identity.teamId!, projectId: project.id, taskId, sessionId }} read={current?.controller ?? null} />
      <ConversationComposer api={api} scope={{ host: identity.host, accountId: identity.account, teamId: identity.teamId!, projectId: project.id, taskId, sessionId }} read={current?.controller ?? null} />
      {snapshot && <section aria-label="会话历史"><h4>已验证 Journal 历史</h4><p>已应用连续游标：{projection!.lastAppliedSeq}；{snapshot.freshness ? <>历史页新鲜度：<Freshness value={snapshot.freshness} /></> : '尚未读取历史新鲜度'}</p><p className="muted">当前元数据与历史记录分别展示。读取完成或订阅监听不代表 Worker 历史完整。</p>{projection!.pendingApprovals.length > 0 && <p role="status">尚未处理的审批：{projection!.pendingApprovals.length}。</p>}{snapshot.status === 'ready' && !visibleEntries?.length && <p>暂无已验证的会话历史。</p>}<ol className="conversation-journal">{visibleEntries?.map(entry => <li key={entry.seq} data-journal-seq={entry.seq}><div className="muted">序号 {entry.seq} <time>{entry.occurredAt}</time></div><JournalEntry entry={entry} snapshot={snapshot} /></li>)}</ol></section>}
    </>}
  </section>
}
