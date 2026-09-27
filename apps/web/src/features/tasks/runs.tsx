import { useEffect, useMemo, useRef, useState } from 'react'
import { randomId } from '../../lib/random.ts'
import { useQuery } from '@tanstack/react-query'
import { unavailableCapability, type LaunchRequest, type Run, type TaskDetail } from '@wemux/web-contract/task-platform'
import { ApiError, type Api } from '../../api/client'
import { projectKeys } from '../../app/project-query'
import { LayerStatus, useBrowserOnline, useRunLayers } from '../../app/layers'
import { RunReview } from './review'
import { LaunchIdentity, LaunchView, taskPrompt } from './launch-draft'
import { useSession } from '../../api/use-session'
import { Button } from '../../components/ui/button'
import { Textarea } from '../../components/ui/textarea'
import { Composer, TimelineEntry, useMessageActions } from '../sessions/conversation'
import { SubmissionController } from '../sessions/submission'
import { useConfirmDialog } from '../../components/ui/confirm-dialog.tsx'

const active = (run: Run) => ['pending', 'running', 'cancelling'].includes(run.status)

export function TaskRuns({ task, api, refresh, search: query, selectRun, onDirty }: { task: TaskDetail; api: Api; refresh: () => void; search: string; selectRun: (id: string) => void; onDirty: (dirty: boolean) => void }) {
  const online = useBrowserOnline()
  const confirm = useConfirmDialog()
  const search = new URLSearchParams(query)
  const draft = useMemo(() => new LaunchIdentity(window.sessionStorage, `wemux.launch:${JSON.stringify([api.launchScope, task.projectId, task.id])}`, taskPrompt(task)), [api, task.projectId, task.id])
  const [independentSession, setIndependentSession] = useState<string | null>(null)
  async function createIndependentSession() {
    if (busy.current) return
    busy.current = true; setPending(true); setError('')
    try { const { session } = await api.createTaskSession(task.projectId, task.id, task.title); setIndependentSession(session.id); setReuseSessionId(session.id); refresh() }
    catch (error) { setError(error instanceof Error ? error.message : '创建会话失败') }
    finally { busy.current = false; setPending(false) }
  }
  const [reuseSessionId, setReuseSessionId] = useState('')
  const [cancelling, setCancelling] = useState(false)
  async function cancel(run: Run, retryRejected = false) {
    if (cancelling || !run.capabilities?.cancel.allowed) return
    setCancelling(true); setError('')
    try {
      const key = `wemux.cancel:${JSON.stringify([api.launchScope, task.projectId, task.id, run.id])}`
      const requestId = (retryRejected ? null : window.sessionStorage.getItem(key)) ?? randomId()
      window.sessionStorage.setItem(key, requestId)
      await api.cancelRun(task.projectId, task.id, { requestId, runId: run.id, sessionId: run.sessionId })
      await runs.refetch(); refresh()
    } catch (error) { setError(error instanceof Error ? error.message : '取消结果未知，请重试原请求') }
    finally { setCancelling(false) }
  }
  const [prompt, setPrompt] = useState(draft.value.prompt)
  const [frozen, setFrozen] = useState<LaunchRequest | null>(draft.value.request)
  const identity = useRef<LaunchRequest | null>(draft.value.request)
  const view = useRef(new LaunchView())
  view.current.update(JSON.stringify([api.launchScope, task.id, query]))
  useEffect(() => () => view.current.leave(), [])
  const dirtyCallback = useRef(onDirty); dirtyCallback.current = onDirty
  useEffect(() => { dirtyCallback.current(draft.value.status === 'unknown' || (!frozen && prompt !== taskPrompt(task))) })
  useEffect(() => () => dirtyCallback.current(false), [])
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const runs = useQuery({ queryKey: projectKeys.runs(task.projectId, task.id), queryFn: ({ signal }) => api.runs(task.projectId, task.id, signal) })
  const selected = runs.data?.find(run => run.id === search.get('run'))
  const current = runs.data?.find(active)
  const launchCapability = (reuseSessionId ? task.capabilities?.reuse[reuseSessionId] : task.capabilities?.launchNew) ?? unavailableCapability
  const select = selectRun
  async function launch() {
    if (busy.current || (!identity.current && !launchCapability.allowed)) return
    const isCurrent = view.current.capture(), location = window.location.href
    const visible = () => isCurrent() && window.location.href === location
    busy.current = true; setPending(true); setError('')
    try {
      const request = draft.freeze(identity.current ?? { requestId: randomId(), ...(reuseSessionId ? { mode: 'reuse' as const, reuseSessionId } : { mode: 'new' as const, reuseSessionId: null }), prompt, assignment: { ...task.assignee! } })
      identity.current = request; setFrozen(request); dirtyCallback.current(true)
      const { run } = await api.launch(task.projectId, task.id, request)
      draft.settle('confirmed')
      if (visible()) { dirtyCallback.current(false); select(run.id); void runs.refetch(); refresh() }
    } catch (e) {
      if (e instanceof ApiError && e.status && (e.status === 400 || e.status === 409)) draft.settle('rejected')
      if (visible()) setError(e instanceof Error ? e.message : '启动失败；请保留原请求重试')
    }
    finally { busy.current = false; if (visible()) setPending(false) }
  }
  return <section className="space-y-4" aria-label="任务运行">
    <h3 className="font-semibold">Runs · 单次初始消息执行</h3>
    <Button variant="outline" disabled={pending || !task.assignee} onClick={() => void createIndependentSession()}>创建独立任务会话（不启动 Run）</Button>
    {independentSession && <p className="break-all" role="status">已创建独立会话：{independentSession}；<a className="underline" href={`/projects/${encodeURIComponent(task.projectId)}/sessions/${encodeURIComponent(independentSession)}`}>打开独立会话</a>；或明确选择 reuse 启动 Run。</p>}
    <p className="text-sm">当前 Assignment（只影响后续运行）：{JSON.stringify(task.assignee)}</p>
    {runs.error && <p role="alert">{runs.error.message}</p>}
    <ul>{runs.data?.map(run => <li key={run.id}><Button variant="outline" onClick={() => select(run.id)}>#{run.attempt} · {run.status} · {run.createdAt}</Button></li>)}</ul>
    {current && <p role="status">已有活跃 Run；不可新启动。<Button variant="outline" onClick={() => select(current.id)}>查看运行</Button><Button variant="outline" disabled={cancelling || !online || !current.capabilities?.cancel.allowed} onClick={() => void cancel(current)}>{cancelling ? '正在受理…' : current.status === 'cancelling' ? '重试取消 Run' : '取消 Run'}</Button>{!current.capabilities?.cancel.allowed && (current.capabilities?.cancel ?? unavailableCapability).reason} 取消受理后须等待 Worker Journal 确认。</p>}
    {current?.failure?.code === 'cancel_rejected' && <div role="alert"><p>取消被拒绝：{current.failure.message}</p><Button disabled={cancelling || !online || !current.capabilities?.cancel.allowed} onClick={() => void cancel(current, true)}>确认重新取消（新请求）</Button></div>}
    {!launchCapability.allowed && <p role="status">{launchCapability.reason}</p>}
    <fieldset className="space-y-3 border border-border p-3"><legend>确认 Session 执行</legend><label className="block">会话模式<select aria-label="会话模式" className="block max-w-full" disabled={!!frozen} value={reuseSessionId} onChange={e => setReuseSessionId(e.target.value)}><option value="">new · 新会话</option>{independentSession && <option value={independentSession}>reuse · 独立任务会话</option>}{[...new Set(runs.data?.filter(run => !active(run)).map(run => run.sessionId))].map(id => <option key={id} value={id}>reuse · {id}</option>)}</select></label>
      <p className="text-sm">执行目标：{JSON.stringify(frozen?.assignment ?? task.assignee)}</p>
      <Textarea aria-label="Run Prompt" value={prompt} disabled={!!frozen} onChange={e => { draft.edit(e.target.value); setPrompt(e.target.value) }} />
      {frozen && <p className="break-all text-xs">已冻结完整请求 {frozen.requestId}；网络失败后重试不会新建尝试。</p>}
      {error && <p role="alert">{error}。草稿及请求身份已保留。</p>}
      <Button disabled={pending || !prompt.trim() || (!frozen && !launchCapability.allowed)} onClick={() => void launch()}>{pending ? '正在启动…' : frozen ? '重试原请求' : `确认并启动 ${reuseSessionId ? 'reuse' : 'new'}`}</Button>
      {frozen && <Button variant="outline" disabled={pending || draft.value.status === 'unknown'} onClick={() => { void confirm({ title: '显式重新确认', description: '已核对原请求结果。保留 Prompt，重新确认当前 Assignment？', confirmLabel: '重新确认', danger: true }).then(ok => { if (ok) { draft.reconfirm(); identity.current = null; setFrozen(null); setError('') } }) }}>显式重新确认</Button>}
      <p className="text-xs">结果未知时须重试原请求核对；刷新保留完整身份。仅明确结果后显式重新确认才替换身份；关闭标签页会清除此标签页记录。</p>
      <p className="text-xs">reuse 须通过归属、绑定与空闲检查；拒绝时不会自动切换 new。取消 Run 仅针对初始消息，不清空独立消息，不自动改变任务状态。</p>
    </fieldset>
    {search.get('run') && !selected && !runs.isPending && <p role="alert">此 Task 中未找到该 Run。</p>}
    {selected && <><RunReview key={`review:${selected.id}`} api={api} task={task} run={selected} refresh={refresh} /><RunInspector key={selected.id} run={selected} api={api} /></>}
  </section>
}
function RunInspector({ run, api }: { run: Run; api: Api }) {
  const confirm = useConfirmDialog()
  const session = useQuery({ queryKey: projectKeys.session(run.projectId, run.sessionId), queryFn: ({ signal }) => api.session(run.sessionId, signal).catch(error => { if (error instanceof ApiError && error.status === 404) return null; throw error }) })
  const journal = useSession(api, session.data ? run.sessionId : '', 0)
  const controller = useMemo(() => new SubmissionController(api, run.sessionId), [api, run.sessionId])
  useEffect(() => () => controller.dispose(), [controller])
  const [deleteError, setDeleteError] = useState('')
  const online = useBrowserOnline()
  const workers = useQuery({ queryKey: ['workers'], queryFn: ({ signal }) => api.workers(signal) })
  const journalState = session.data === null ? 'N/A（Session 已删除）' : !online ? 'offline' : journal.error || session.error ? 'stale' : journal.freshness?.status ?? 'unknown'
  useRunLayers(run.snapshot.workerId, journalState)
  const confirmedIds = journal.messages.map(message => message.id)
  const canSend = Boolean(session.data && online && session.data.access?.canWrite !== false && session.data.sendCapability?.allowed === true)
  const { hiddenMessageIds, localNotice, messageActions } = useMessageActions(controller, run.sessionId, canSend)
  return <section aria-label="Run inspector" className="space-y-4 border-t border-border pt-4">
    <h3 className="font-semibold">Run #{run.attempt} · {run.status}</h3>
    <LayerStatus online={online} server={session.error || workers.error ? 'stale / unreachable' : session.isPending ? 'unknown' : 'connected'} worker={workers.data?.find(worker => worker.id === run.snapshot.workerId)?.connectionState ?? 'unknown'} journal={journalState} />
    <dl className="break-all text-sm"><dt>不可变执行快照</dt><dd>{JSON.stringify(run.snapshot)}</dd><dt>创建 / 开始 / 完成</dt><dd>{run.createdAt} / {run.startedAt ?? '尚未开始'} / {run.finishedAt ?? '尚未完成'}</dd><dt>结果</dt><dd className="whitespace-pre-wrap">{run.resultSummary ?? '等待 Journal'}</dd><dt>失败</dt><dd>{run.failure?.message ?? '无'}</dd><dt>Freshness</dt><dd>{journal.freshness?.status ?? 'unknown'} · seq {run.lastProjectedSeq}</dd></dl>
    {!active(run) && <Button variant="outline" onClick={async () => {
      const key = `wemux.cancel:${JSON.stringify([api.launchScope, run.projectId, run.taskId, run.id])}`
      const requestId = window.sessionStorage.getItem(key)
      if (!requestId) return
      await api.cancelRun(run.projectId, run.taskId, { requestId, runId: run.id, sessionId: run.sessionId })
    }}>核对原取消请求</Button>}
    {run.status === 'succeeded' && <p>执行成功；建议人工审查。Task 状态未自动改变。</p>}
    <p className="text-sm">以下为本次运行的会话记录；初始消息以外的追加消息不属于本 Run、不延长生命周期。</p>{session.data && <a className="inline-flex items-center rounded-md border border-border px-3 py-2 text-sm underline" href={`/projects/${encodeURIComponent(run.projectId)}/sessions/${encodeURIComponent(run.sessionId)}`}>打开完整对话</a>}
    {session.data && !active(run) && <Button variant="outline" onClick={async () => {
      if (!await confirm({ title: '删除 Session 历史', description: '删除此会话及其对话历史？Run 快照仍保留。', confirmLabel: '删除', danger: true })) return
      try { await api.deleteSession(run.sessionId); await session.refetch(); setDeleteError('') }
      catch (error) { setDeleteError(error instanceof Error ? error.message : '删除失败') }
    }}>删除 Session 历史</Button>}
    {deleteError && <p role="alert">{deleteError}</p>}
    {session.data === null && <p role="status">会话已删除，无法加载运行日志。以下运行历史快照仍保留。</p>}
    {journal.error && <p role="alert">{journal.error}</p>}
    {journal.timeline.filter(entry => !hiddenMessageIds.has(entry.id)).map(entry => <TimelineEntry key={entry.id} entry={entry} api={api} sessionId={run.sessionId} messageActions={messageActions} />)}
    {localNotice && <p role="status">{localNotice}</p>}
    {session.data && <><h4>追加独立消息（不属于本 Run）</h4><Composer api={api} controller={controller} session={session.data} activeTurnId={journal.activeTurnId} canSend={canSend} blockedReason={!online ? '浏览器当前离线' : session.data.access?.canWrite === false ? '当前账号只有查看权限' : (session.data.sendCapability ?? unavailableCapability).reason} confirmedIds={confirmedIds} /></>}
  </section>
}
