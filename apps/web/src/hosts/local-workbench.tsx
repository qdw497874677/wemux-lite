import { useEffect, useMemo, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { createLocalJournal } from './session-journal.ts'
import { createLocalSessionApi, type LocalDirectory, type LocalSessionRecord, type LocalStatus } from './local-session.ts'
import { isHostPathAllowed } from '../app/host-paths.ts'
import { useSession } from '../api/use-session.ts'
import { TimelineEntry } from '../features/sessions/conversation.tsx'
import { Conversation, ConversationContent, ConversationScrollButton } from '../components/ai-elements/conversation.tsx'
import { randomId } from '../lib/random.ts'
import { LocalCluster } from './local-cluster.tsx'
import { LocalSettings } from './local-settings.tsx'

function LocalTimeline({ session, api }: { session: LocalSessionRecord; api: ReturnType<typeof createLocalSessionApi> }) {
  const journal = useMemo(() => createLocalJournal(fetch, () => setExpired(true)), [])
  const [revision, setRevision] = useState(0)
  const [expired, setExpired] = useState(false)
  const [content, setContent] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [attempt, setAttempt] = useState<{ content: string; ids: { commandId: string; messageId: string } } | null>(null)
  const [actions, setActions] = useState<Record<string, 'approve' | 'deny'>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [queuedAction, setQueuedAction] = useState<{ commandId: string; status: 'pending' | 'accepted' } | null>(null)
  const history = useSession(journal, session.sessionId, revision)
  useEffect(() => {
    if (attempt && history.messages.some(message => message.id === attempt.ids.messageId)) {
      setAttempt(null); setContent(current => current === attempt.content ? '' : current); setError('')
    }
  }, [attempt, history.messages])
  const send = async () => {
    if (!content.trim() || pending || expired || history.freshness?.status !== 'synced') return
    const text = content.trim(), ids = attempt?.content === text ? attempt.ids : { commandId: randomId(), messageId: randomId() }
    setAttempt({ content: text, ids }); setPending(true); setError('')
    try { await api.send(session.sessionId, text, ids); setAttempt(null); setContent(''); setRevision(value => value + 1) }
    catch (cause) { setError(cause instanceof Error ? `${cause.message}；重试会复用原请求标识。` : '发送结果未知；重试会复用原请求标识。') }
    finally { setPending(false) }
  }
  const cancelQueued = async (commandId: string) => {
    if (busy || expired || history.freshness?.status !== 'synced' || !history.queuedItems.some(item => item.commandId === commandId)) return
    setQueuedAction({ commandId, status: 'pending' }); setBusy(`queue:${commandId}`); setError('')
    try { await api.cancelQueued(session.sessionId, commandId); setQueuedAction({ commandId, status: 'accepted' }); setRevision(value => value + 1) }
    catch (cause) { setQueuedAction(null); setError(cause instanceof Error ? cause.message : '取消排队失败') }
    finally { setBusy(null) }
  }
  const resolveApproval = async (approvalId: string, decision: 'approve' | 'deny') => {
    if (busy || expired || history.freshness?.status !== 'synced' || !history.pendingApprovals.some(item => item.approvalId === approvalId)) return
    const commandId = randomId()
    setBusy(`approval:${approvalId}`); setError('')
    try { await api.resolveApproval(session.sessionId, approvalId, decision, commandId); setActions(current => ({ ...current, [approvalId]: decision })); setRevision(value => value + 1) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '审批处理失败') }
    finally { setBusy(null) }
  }
  const stop = async () => {
    if (!history.activeTurnId || expired) return
    try { await api.stop(session.sessionId, history.activeTurnId); setRevision(value => value + 1) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '停止失败') }
  }
  return <section className="flex min-h-0 flex-1 flex-col gap-3" aria-label="本地会话">
    <header className="border-b border-border pb-3"><h2 className="text-lg font-medium">本地会话</h2><p className="text-sm text-muted-foreground">{session.binding.agent.agentKey} / {session.binding.modelId ?? '默认模型'}</p></header>
    {expired && <p role="alert" className="text-sm text-error-foreground">本机登录已失效。<a href="/local" className="underline">返回登录</a></p>}
    {history.error && <p role="alert" className="text-sm text-error-foreground">{history.error}</p>}
    {history.stream !== 'live' && <p role="status" className="text-xs text-muted-foreground">实时连接恢复中，历史仍会补传。</p>}
    <Conversation className="min-h-40 flex-1" aria-live="polite"><ConversationContent className="mx-auto w-full max-w-[var(--chat-max-width)] space-y-3">
      {!history.timeline.length && <p className="text-sm text-muted-foreground">{history.checkedAt ? '暂无消息，可以开始对话。' : '正在加载历史…'}</p>}
      {history.timeline.map(entry => <TimelineEntry key={entry.id} entry={entry} />)}
    </ConversationContent><ConversationScrollButton /></Conversation>
    {history.queuedItems.length > 0 && <section aria-label="排队消息" className="space-y-2 rounded-md border border-border p-3"><h3 className="text-sm font-medium">排队消息</h3>{history.queuedItems.map(item => <div key={item.commandId} className="flex items-center justify-between gap-3 text-sm"><span className="min-w-0 truncate">{item.content}</span><button type="button" className="shrink-0 underline disabled:opacity-50" disabled={expired || !!busy || history.freshness?.status !== 'synced'} onClick={() => void cancelQueued(item.commandId)}>取消排队</button>{queuedAction?.commandId === item.commandId && <span className="text-xs text-muted-foreground">{queuedAction.status === 'pending' ? '提交中' : '已提交，等待 Journal 确认'}</span>}</div>)}</section>}
    {history.pendingApprovals.length > 0 && <section aria-label="待处理审批" className="space-y-2 rounded-md border border-border p-3"><h3 className="text-sm font-medium">待处理审批</h3>{history.pendingApprovals.map(item => <div key={item.approvalId} className="space-y-2 text-sm"><p>{item.reason || 'Agent 请求执行操作'}：{typeof item.action === 'string' ? item.action : JSON.stringify(item.action)}</p><div className="flex gap-3">{(['approve', 'deny'] as const).map(decision => <button key={decision} type="button" className="underline disabled:opacity-50" disabled={expired || !!busy || history.freshness?.status !== 'synced'} onClick={() => void resolveApproval(item.approvalId, decision)}>{decision === 'approve' ? '批准' : '拒绝'}</button>)}</div>{actions[item.approvalId] && <p className="text-muted-foreground">已提交{actions[item.approvalId] === 'approve' ? '批准' : '拒绝'}请求；以 Journal 收敛结果为准。</p>}</div>)}</section>}
    {error && <p role="alert" className="text-sm text-error-foreground">{error}</p>}
    <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void send() }}>
      <label htmlFor="local-prompt" className="text-sm">消息</label><textarea id="local-prompt" className="min-h-24 rounded-md border border-border bg-background p-3" value={content} onChange={event => setContent(event.target.value)} />
      <div className="flex gap-2"><button className="rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={expired || !content.trim() || pending || history.freshness?.status !== 'synced'}>发送</button><button type="button" className="rounded-md border border-border px-3 py-2 disabled:opacity-50" disabled={expired || !history.activeTurnId} onClick={() => void stop()}>停止运行</button></div>
    </form>
  </section>
}

export function LocalWorkbench() {
  const pathname = useRouterState({ select: state => state.location.pathname })
  if (!isHostPathAllowed('local-worker', pathname)) return <main role="alert" className="p-6">链接不存在。<a href="/local">返回本地工作台</a></main>
  return <LocalWorkbenchBody pathname={pathname} />
}

function LocalWorkbenchBody({ pathname }: { pathname: string }) {
  const [revision, setRevision] = useState(0)
  const [status, setStatus] = useState<LocalStatus | null>(null)
  const [directories, setDirectories] = useState<LocalDirectory[]>([])
  const [sessions, setSessions] = useState<LocalSessionRecord[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [directoryPath, setDirectoryPath] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [agentKey, setAgentKey] = useState('')
  const [modelId, setModelId] = useState('')
  const api = useMemo(() => createLocalSessionApi(fetch, () => { setStatus(null); setSessions([]); setError('本机登录已失效，请重新登录。') }), [])
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const state = await api.status()
        const [dirs, items] = await Promise.all([api.directories(), api.sessions()])
        if (!active) return
        setStatus(state); setDirectories(dirs); setSessions(items); setWorkspaceId(current => current || dirs[0]?.workspaceId || '')
      } catch (cause) { if (active && !(cause instanceof Error && cause.message.includes('Authentication required'))) setError(cause instanceof Error ? cause.message : '本地工作台无法连接') }
      finally { if (active) setLoading(false) }
    })()
    return () => { active = false }
  }, [api, revision])
  const sessionId = pathname.match(/^\/local\/sessions\/([^/]+)$/)?.[1]
  const selected = sessions.find(item => item.sessionId === sessionId)
  const agents = status?.capabilities.filter(agent => agent.mode === 'execution' && agent.availability.status === 'available' && agent.models.length) ?? []
  const models = agents.find(agent => agent.agentKey === agentKey)?.models ?? []
  const refresh = () => setRevision(value => value + 1)
  const logout = async () => {
    try { await api.logout(); window.location.assign('/local') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '退出登录失败') }
  }
  return <main className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-5 p-4 text-foreground sm:p-8">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4"><div><p className="text-xs uppercase tracking-widest text-muted-foreground">Wemux Worker</p><h1 className="text-2xl font-semibold">本机工作台</h1></div><div className="flex gap-3 text-sm"><a href="/" className="underline">返回 Worker 当前页面</a>{status && <button type="button" className="underline" onClick={() => void logout()}>退出登录</button>}</div></header>
    {loading && <p role="status">正在连接本机 Worker…</p>}
    {error && <p role="alert" className="text-sm text-error-foreground">{error}</p>}
    {!loading && !status && <form className="flex max-w-sm flex-col gap-3" onSubmit={event => { event.preventDefault(); setError(''); void api.login(username, password).then(() => { setPassword(''); refresh() }, cause => setError(cause instanceof Error ? cause.message : '登录失败')) }}><h2 className="text-lg">管理员登录</h2><label>用户名<input className="w-full rounded-md border border-border bg-background p-2" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required /></label><label>密码<input className="w-full rounded-md border border-border bg-background p-2" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /></label><button className="rounded-md bg-primary px-3 py-2 text-primary-foreground">登录</button></form>}
    {status && <div className="grid flex-1 gap-6 md:grid-cols-[15rem_1fr]"><aside className="space-y-4"><p className="text-sm text-muted-foreground">{status.installation.name}</p><nav className="flex flex-col gap-2 text-sm"><a href="/local">本地会话</a><a href="/local/settings">本地设置</a><a href="/local/cluster">集群接入</a></nav><form className="space-y-2 border-t border-border pt-4" onSubmit={event => { event.preventDefault(); void api.addDirectory(directoryPath).then(dir => { setWorkspaceId(dir.workspaceId); setDirectoryPath(''); refresh() }, cause => setError(cause instanceof Error ? cause.message : '添加目录失败')) }}><label className="text-sm">授权目录<input className="mt-1 w-full rounded-md border border-border bg-background p-2" value={directoryPath} onChange={event => setDirectoryPath(event.target.value)} placeholder="/absolute/path" required /></label><button className="rounded-md border border-border px-2 py-1 text-sm">添加目录</button></form><form className="space-y-2 border-t border-border pt-4" onSubmit={event => { event.preventDefault(); void api.create(workspaceId, agentKey, modelId).then(session => { window.location.assign(`/local/sessions/${encodeURIComponent(session.sessionId)}`) }, cause => setError(cause instanceof Error ? cause.message : '创建失败')) }}><h2 className="text-sm font-medium">新建会话</h2><select aria-label="目录" className="w-full rounded-md border border-border bg-background p-2" value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} required>{directories.map(dir => <option key={dir.workspaceId} value={dir.workspaceId}>{dir.name} · {dir.path}</option>)}</select><select aria-label="Agent" className="w-full rounded-md border border-border bg-background p-2" value={agentKey} onChange={event => { setAgentKey(event.target.value); setModelId('') }} required><option value="">选择 Agent</option>{agents.map(agent => <option key={agent.agentKey} value={agent.agentKey}>{agent.displayName}</option>)}</select><select aria-label="模型" className="w-full rounded-md border border-border bg-background p-2" value={modelId} onChange={event => setModelId(event.target.value)} required><option value="">选择模型</option>{models.map(model => <option key={model.modelId} value={model.modelId}>{model.displayName}</option>)}</select><button className="rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={!workspaceId || !agentKey || !modelId}>新建会话</button></form><nav aria-label="会话列表" className="flex flex-col gap-1 border-t border-border pt-4">{sessions.map(session => <a key={session.sessionId} href={`/local/sessions/${encodeURIComponent(session.sessionId)}`} className="truncate rounded-md px-2 py-1 text-sm hover:bg-accent">{session.binding.agent.agentKey} / {session.binding.modelId ?? '默认模型'}</a>)}</nav></aside><div className="min-w-0">{pathname === '/local/settings' ? <LocalSettings api={api} /> : pathname === '/local/cluster' ? <LocalCluster api={api} status={status} refresh={refresh} /> : sessionId ? selected ? <LocalTimeline key={selected.sessionId} session={selected} api={api} /> : <p role="alert">本地会话不存在或当前账号无权读取。</p> : <p className="text-sm text-muted-foreground">选择已有会话，或授权目录并新建会话。此处不加载集群 Project 数据。</p>}</div></div>}
  </main>
}
