import { useEffect, useMemo, useRef, useState } from 'react'
import { PendingTaskRun, PendingRunCancellation, PendingHumanReview, PendingHumanDecision, PendingTaskCompletion, DecisionVersionConflict, ReviewVersionConflict, CompletionVersionConflict, type TaskRunIntent } from '@wemux/web-client'
import type { TaskDetail, TaskSessionView, Run, LaunchRequest, ReviewRequest } from '@wemux/web-contract/task-platform'
import type { ProjectDTO } from '@wemux/web-contract/browser-host'
import type { ProjectClient } from './ProjectManagement.tsx'
import { accountError, useAccountData } from './AccountForms.tsx'
import { Button } from './primitives.tsx'

const statusLabels: Record<Run['status'], string> = { pending: '排队中', running: '运行中', cancelling: '取消中', succeeded: '已成功', failed: '失败', cancelled: '已取消' }
// A list snapshot only suggests candidates. The Server checks current idleness,
// ownership, placement and binding again when accepting a Run.
function reuseCandidate(session: TaskSessionView, task: TaskDetail, accountId: string | null | undefined): boolean {
  const assignment = task.assignee
  return !!assignment && !!accountId && session.projectId === task.projectId && session.taskId === task.id
    && session.ownerId === accountId && session.access.canWrite && !session.deletedAt && !session.archivedAt
    && session.freshness.status === 'synced' && session.runtimeState === 'idle'
    && session.activeTurnId === null && session.queuedMessages.length === 0
    && session.binding.workspaceId === assignment.workspaceId && session.workspaceId === assignment.workspaceId
    && session.binding.agent.workerId === assignment.workerId && session.binding.agent.agentKey === assignment.agentKey
    && session.binding.modelId === assignment.modelId
}
export function TaskRuns({ api, project, task, runId, selectSession, changed, reconcile, reconciliationReady }: { api: ProjectClient; project: ProjectDTO; task: TaskDetail; runId: string; selectSession: (id: string) => void; changed: () => void; reconcile: (version: number) => void; reconciliationReady: boolean }) {
  const runs = useAccountData(() => api.taskRuns(project.id, task.id), [api, project.id, task.id])
  const sessions = useAccountData(() => api.taskSessions(project.id, task.id), [api, project.id, task.id])
  const reviews = useAccountData(() => api.pendingReviews(project.id), [api, project.id])
  const selectedRun = runs.data?.find(run => run.id === runId && run.taskId === task.id && run.projectId === project.id)
  const selectedRow = useRef<HTMLLIElement>(null)
  // The parent keys this history by account/host, Project and Task. Wait for
  // that scope's loaded history; never substitute the latest attempt.
  useEffect(() => {
    if (selectedRun) {
      selectedRow.current?.focus({ preventScroll: true })
      selectedRow.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedRun?.id])
  const [prompt, setPrompt] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [launchMode, setLaunchMode] = useState<'new' | 'reuse'>('new'), [reuseSessionId, setReuseSessionId] = useState('')
  const [summary, setSummary] = useState(''), [evidence, setEvidence] = useState(''), [decisionReason, setDecisionReason] = useState('')
  const [humanReview] = useState(() => new PendingHumanReview(() => window.sessionStorage, { ...api.taskSessionScope, projectId: project.id, taskId: task.id }))
  const [completion] = useState(() => new PendingTaskCompletion(() => window.sessionStorage, { ...api.taskSessionScope, projectId: project.id, taskId: task.id }))
  const [completionSnapshot, setCompletionSnapshot] = useState(() => { try { return completion.read() } catch { return null } })
  const [completionStorageError, setCompletionStorageError] = useState(() => { try { completion.read(); return '' } catch (cause) { return accountError(cause) } })
  const [completionRejection, setCompletionRejection] = useState<string | null>(null)
  const [reviewSnapshot, setReviewSnapshot] = useState(() => { try { return humanReview.read() } catch { return null } })
  const [reviewStorageError, setReviewStorageError] = useState(() => { try { humanReview.read(); return '' } catch (cause) { return accountError(cause) } })
  const [reviewRejection, setReviewRejection] = useState<string | null>(null)
  const [humanDecision] = useState(() => new PendingHumanDecision(() => window.sessionStorage, { ...api.taskSessionScope, projectId: project.id, taskId: task.id }, api.controlIdentity.accountId ?? ''))
  const [decisionSnapshot, setDecisionSnapshot] = useState(() => { try { return humanDecision.read() } catch { return null } })
  const [decisionStorageError, setDecisionStorageError] = useState(() => { try { humanDecision.read(); return '' } catch (cause) { return accountError(cause) } })
  const [decisionRejection, setDecisionRejection] = useState<string | null>(null)
  const [reconciling, setReconciling] = useState(false)
  const [pending] = useState(() => new PendingTaskRun(() => window.sessionStorage, { ...api.taskSessionScope, projectId: project.id, taskId: task.id }))
  const [snapshot, setSnapshot] = useState<LaunchRequest | null>(() => { try { return pending.read() } catch { return null } })
  const [storageError, setStorageError] = useState(() => { try { pending.read(); return '' } catch (cause) { return accountError(cause) } })
  const cancellation = (run: Run) => new PendingRunCancellation(() => window.sessionStorage, { ...api.taskSessionScope, projectId: project.id, taskId: task.id, runId: run.id, sessionId: run.sessionId })
  const activeRun = useMemo(() => runs.data?.find(run => ['pending', 'running', 'cancelling'].includes(run.status)) ?? (!runs.data ? task.activeRun : null), [runs.data, task.activeRun])
  const writable = project.accessRole !== 'viewer' && !task.deletedAt
  const candidates = sessions.data?.filter(session => reuseCandidate(session, task, api.controlIdentity.accountId)
    && runs.data?.some(run => run.taskId === task.id && run.sessionId === session.id)) ?? []
  const latest = runs.data?.reduce<Run | undefined>((last, run) => !last || run.attempt > last.attempt ? run : last, undefined)
  const review: ReviewRequest | undefined = reviews.data?.find(item => item.taskId === task.id && item.id === task.currentReviewId)
  const mayDecide = !!api.controlIdentity.accountId && review?.actor !== api.controlIdentity.accountId && ['owner', 'manager'].includes(project.accessRole)
  useEffect(() => { if (task.currentReviewId) reviews.reload() }, [task.currentReviewId])
  const policy = task.metadataJson.values.reviewPolicy ?? ((runs.data?.length || task.activeRun) ? 'human' : project.reviewPolicy ?? 'none')
  const noReview = policy === 'none'
  const policyLabel = { none: '不强制审查', agent: 'Agent 审查', human: '人工审查', 'multi-stage': '多阶段审查' }[policy as 'none' | 'agent' | 'human' | 'multi-stage'] ?? '未知策略'
  const refresh = () => { try { setSnapshot(pending.read()); setStorageError('') } catch (cause) { setStorageError(accountError(cause)) }; try { setReviewSnapshot(humanReview.read()); setReviewStorageError('') } catch (cause) { setReviewStorageError(accountError(cause)) }; try { setDecisionSnapshot(humanDecision.read()); setDecisionStorageError('') } catch (cause) { setDecisionStorageError(accountError(cause)) }; try { setCompletionSnapshot(completion.read()); setCompletionStorageError('') } catch (cause) { setCompletionStorageError(accountError(cause)) }; runs.reload(); sessions.reload(); reviews.reload() }
  useEffect(() => {
    if (reconciling && reconciliationReady && runs.ready && reviews.ready) setReconciling(false)
  }, [reconciling, reconciliationReady, runs.ready, reviews.ready])
  async function reconcileRejected() {
    if (!reviewSnapshot || reviewRejection !== reviewSnapshot.requestId || reconciling || busy) return
    try {
      humanReview.discardRejected(reviewSnapshot.requestId)
      setReviewSnapshot(null); setReviewRejection(null); setError(''); setReconciling(true)
      reconcile(reviewSnapshot.version); runs.reload(); reviews.reload()
    } catch (cause) { setReviewStorageError(accountError(cause)) }
  }
  async function launch(retry = false) {
    // A lost launch response can leave the original Run active. Its exact
    // request must still be replayable to recover the receipt, never minted anew.
    if (!writable || busy || reconciling || !!storageError || !!decisionStorageError || !!decisionSnapshot || !runs.data || (!retry && (!runs.ready || !!activeRun))) return
    setBusy(true); setError(''); setNotice('')
    try {
      const saved = retry ? pending.read() : null
      if (!retry && pending.read()) throw Error('已有待确认的 Run 请求；请重试原请求并核对回执，未创建新执行。')
      // Do not silently switch to a new Session if the selected reuse target
      // disappeared or became ineligible while the form was open.
      const selected = !retry && launchMode === 'reuse' && sessions.ready
        ? candidates.find(session => session.id === reuseSessionId) : undefined
      if (!retry && launchMode === 'reuse' && !selected) throw Error('复用会话未就绪或状态已变化；请刷新会话列表并重新选择，未创建新 Run。')
      if (selected && !window.confirm(`确认复用同一 Task 的 Session？\nSession：${selected.title} (${selected.id})\n执行环境：${selected.binding.workspaceId} / ${selected.binding.agent.workerId} / ${selected.binding.agent.agentKey} / ${selected.binding.modelId ?? '默认模型'}\n服务端仍将校验会话是否空闲。`)) return
      if (retry && (!saved || JSON.stringify(saved) !== JSON.stringify(snapshot))) throw Error('原请求身份已变化，未发起新 Run。请核对待确认记录。')
      const result = await pending.run((): TaskRunIntent => {
        if (retry) throw Error('原 Run 请求已不再待确认；未发送新的执行。请刷新记录核对。')
        if (!task.assignee || !prompt.trim()) throw Error('请先指派执行环境并填写本次运行目标。')
        return selected
          ? { mode: 'reuse', reuseSessionId: selected.id, prompt, assignment: task.assignee }
          : { mode: 'new', reuseSessionId: null, prompt, assignment: task.assignee }
      }, body => {
        if (retry && JSON.stringify(body) !== JSON.stringify(saved)) throw Error('待确认的 Run 身份已被替换；未发送。')
        return api.launchTask(project.id, task.id, body)
      })
      if (retry && result.run.requestId !== saved?.requestId) throw Error('已加入的请求不是原 Run；请核对最新执行记录。')
      setNotice(`已确认 Run ${result.run.attempt}：${statusLabels[result.run.status]}。请查看关联 Session。`)
      changed()
      runs.reload()
    } catch (cause) { setError(accountError(cause)) }
    finally { setBusy(false); refresh() }
  }
  async function cancel(run: Run) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await cancellation(run).run(requestId => api.cancelTaskRun(project.id, task.id, run.id, run.sessionId, requestId))
      setNotice(result.run.cancelRequestedAt === null ? `Run 已结束，无需取消。当前状态：${statusLabels[result.run.status]}。` : `取消请求已受理，当前 Run：${statusLabels[result.run.status]}。终态以 Worker 回执和 Journal 为准。`)
      runs.reload()
    } catch (cause) { setError(accountError(cause)) }
    finally { setBusy(false) }
  }
  async function complete(retry = false) {
    if (busy || reconciling || !writable || !!completionStorageError || (!retry && (!!completionSnapshot || !runs.data || !!activeRun || !latest || latest.status !== 'succeeded' || !noReview || task.status !== 'in_progress' || !summary.trim()))) return
    setBusy(true); setError(''); setNotice('')
    try {
      const saved = retry ? completion.read() : null
      if (retry && (!saved || JSON.stringify(saved) !== JSON.stringify(completionSnapshot))) throw Error('原完成请求身份已变化；未发送。请核对待确认记录。')
      const result = await completion.run(() => {
        if (retry) throw Error('原完成请求已不再待确认；请刷新核对。')
        return { version: task.version, runId: latest!.id, summary, evidence: evidence.split('\n').map(line => line.trim()).filter(Boolean) }
      }, body => {
        if (retry && JSON.stringify(body) !== JSON.stringify(saved)) throw Error('待确认的完成请求已被替换；未发送。')
        return api.completeTask(project.id, task.id, body)
      })
      if (result.runId !== (retry ? saved?.runId : latest!.id) || result.task.id !== task.id || result.task.projectId !== project.id || result.task.status !== 'done') throw Error('完成回执与当前 Task 或 Run 不符；保留原请求，请刷新确认。')
      setNotice('已提交完成，任务状态以服务端为准。'); changed()
    } catch (cause) { if (cause instanceof CompletionVersionConflict) { try { setCompletionRejection(completion.read()?.requestId ?? null) } catch { /* reported below */ } } setError(accountError(cause)) }
    finally {
      setBusy(false)
      try { setCompletionSnapshot(completion.read()); setCompletionStorageError('') } catch (cause) { setCompletionStorageError(accountError(cause)) }
    }
  }
  async function submitHumanReview(retry = false) {
    if (busy || reconciling || !writable || !!reviewStorageError || !!decisionStorageError || !!decisionSnapshot || (!retry && (!!reviewSnapshot || !runs.data || !!activeRun || !latest || latest.status !== 'succeeded' || (policy !== 'human' && policy !== 'multi-stage') || task.status !== 'in_progress' || !summary.trim()))) return
    setBusy(true); setError(''); setNotice('')
    try {
      const saved = retry ? humanReview.read() : null
      if (retry && (!saved || JSON.stringify(saved) !== JSON.stringify(reviewSnapshot))) throw Error('原人工审查请求身份已变化；未发送。请核对待确认记录。')
      await humanReview.run(() => {
        if (retry) throw Error('原人工审查请求已不再待确认；勿新建请求。')
        return { version: task.version, runId: latest!.id, summary, evidence: evidence.split('\n').map(line => line.trim()).filter(Boolean) }
      }, body => {
        if (retry && JSON.stringify(body) !== JSON.stringify(saved)) throw Error('待确认的人工审查请求已被替换；未发送。')
        return api.submitHumanReview(project.id, task.id, body)
      })
      setNotice('人工审查提交已确认；需等待获授权的审查参与者处理，不代表已经批准或完成。'); changed(); runs.reload()
    } catch (cause) { if (cause instanceof ReviewVersionConflict) { try { setReviewRejection(humanReview.read()?.requestId ?? null) } catch { /* storage error is reported below */ } } setError(accountError(cause)) }
    finally {
      setBusy(false)
      try { setReviewSnapshot(humanReview.read()); setReviewStorageError('') } catch (cause) { setReviewStorageError(accountError(cause)) }
    }
  }
  async function decideHumanReview(status: 'approved' | 'changes_requested', retry = false) {
    if (busy || reconciling || !!decisionStorageError || !api.controlIdentity.accountId || (!retry && (!!decisionSnapshot || !review || !mayDecide || !runs.ready || !reviews.ready || task.status !== 'in_review' || (policy !== 'human' && policy !== 'multi-stage') || latest?.status !== 'succeeded' || !!activeRun || (status === 'changes_requested' && !decisionReason.trim())))) return
    setBusy(true); setError(''); setNotice('')
    try {
      const saved = retry ? humanDecision.read() : null
      if (retry && (!saved || JSON.stringify(saved) !== JSON.stringify(decisionSnapshot))) throw Error('原审查决定身份已变化；未发送新的决定。')
      const result = await humanDecision.run(() => {
        if (retry) throw Error('原审查决定已不再待确认；请先刷新核对。')
        return { version: task.version, reviewId: review!.id, status, ...(status === 'changes_requested' ? { reason: decisionReason.trim() } : {}) }
      }, body => {
        if (retry && JSON.stringify(body) !== JSON.stringify(saved)) throw Error('待确认的审查决定已被替换；未发送。')
        return api.decideHumanReview(project.id, task.id, body)
      })
      setNotice(result.task.status === 'done' ? '审查已批准，Task 已完成。' : result.task.status === 'in_review' ? `已批准第 ${result.review.stageIndex ?? '?'} 阶段；任务进入下一阶段审查。` : '审查要求修改，Task 已回到进行中。')
      setDecisionReason(''); changed(); reviews.reload(); runs.reload()
    } catch (cause) { if (cause instanceof DecisionVersionConflict) { try { setDecisionRejection(humanDecision.read()?.requestId ?? null) } catch { /* reported below */ } } setError(accountError(cause)) }
    finally {
      setBusy(false)
      try { setDecisionSnapshot(humanDecision.read()); setDecisionStorageError('') } catch (cause) { setDecisionStorageError(accountError(cause)) }
    }
  }
  return <section aria-label="任务运行" className="account-section"><h3>任务运行</h3><p>Run 记录执行尝试，不会因成功自动完成 Task。当前审查要求：{policyLabel}{task.metadataJson.values.reviewPolicyFrozen === true ? '（首次执行时已固定）' : (runs.data?.length || task.activeRun) ? '（历史执行缺少策略快照，保守按人工审查）' : '（首次执行前按项目默认值）'}。人工审查由获授权的其他参与者决定；多阶段审查为固定的两段人工链，需彼此独立的获权参与者逐段批准，未通过段不得跳过；Agent 审查仍需真实已授权的 Agent 决策面，未开放前不可用。</p>
    <Button variant="outline" onClick={() => { runs.reload(); sessions.reload(); reviews.reload(); changed() }}>刷新运行状态</Button>{runs.feedback}
    {reviewStorageError && <p role="alert">{reviewStorageError}<Button variant="outline" onClick={() => { try { setReviewSnapshot(humanReview.read()); setReviewStorageError('') } catch (cause) { setReviewStorageError(accountError(cause)) } }}>重新读取审查请求</Button></p>}
    {reconciling && <p role="status">正在重新读取任务与 Run，请核对最新版本后再提交。</p>}
    {reviewSnapshot && <div role="status"><p>{reviewRejection === reviewSnapshot.requestId ? '原人工审查请求已被服务端明确拒绝：任务版本已变更。请重新读取任务后核对成果，再发起新请求。' : '原人工审查请求结果尚未确认；请重试原请求以取回回执，不要修改摘要或使用新请求。'}</p>{reviewRejection === reviewSnapshot.requestId ? <Button variant="outline" disabled={!writable || busy || !!reviewStorageError} onClick={() => void reconcileRejected()}>放弃已拒绝请求并重新核对</Button> : <Button variant="outline" disabled={!writable || busy || !!reviewStorageError} onClick={() => void submitHumanReview(true)}>重试原人工审查请求</Button>}</div>}
    {decisionStorageError && <p role="alert">{decisionStorageError}<Button variant="outline" onClick={refresh}>重新读取审查决定</Button></p>}
    {decisionSnapshot && <div role="status"><p>{decisionRejection === decisionSnapshot.requestId ? '原审查决定因任务版本变化被明确拒绝。请重新读取 Task、Run 与审查，再明确决定。' : `原审查决定结果尚未确认（${decisionSnapshot.status === 'approved' ? '批准' : '要求修改'}）；仅重试原请求，勿发起另一决定。`}</p>{decisionRejection === decisionSnapshot.requestId ? <Button variant="outline" disabled={busy || reconciling || !!decisionStorageError} onClick={() => { try { humanDecision.discardRejected(); setDecisionSnapshot(null); setDecisionRejection(null); setError(''); setReconciling(true); reconcile(decisionSnapshot.version); runs.reload(); reviews.reload() } catch (cause) { setDecisionStorageError(accountError(cause)) } }}>放弃已拒绝决定并重新核对</Button> : <Button variant="outline" disabled={busy || !!decisionStorageError || reconciling} onClick={() => void decideHumanReview(decisionSnapshot.status, true)}>重试原审查决定</Button>}</div>}
    {storageError && <p role="alert">{storageError}<Button variant="outline" onClick={refresh}>重新读取运行请求</Button></p>}
    {snapshot && <div role="status"><p>原 Run 请求结果尚未确认；只保留当前标签页。不要使用新草稿重发。</p><p>模式：{snapshot.mode === 'reuse' ? '复用原 Session' : '新建 Session'}；{snapshot.mode === 'reuse' && `Session：${snapshot.reuseSessionId}；`}执行环境：{snapshot.assignment.workspaceId} / {snapshot.assignment.workerId} / {snapshot.assignment.agentKey} / {snapshot.assignment.modelId ?? '默认模型'}</p><Button disabled={!writable || busy || reconciling || !!storageError} onClick={() => void launch(true)}>重试原 Run 请求</Button></div>}
    {writable && <form onSubmit={event => { event.preventDefault(); if (!snapshot && !reviewSnapshot && !reviewStorageError && !decisionSnapshot && !decisionStorageError && !completionSnapshot && !completionStorageError && !reconciling && runs.data && !activeRun) void launch() }}><label>本次运行目标<textarea value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={100000} required /></label><fieldset disabled={busy || !!snapshot || !!activeRun}><legend>关联 Session</legend><label><input type="radio" name="run-session-mode" checked={launchMode === 'new'} onChange={() => setLaunchMode('new')} /> 新建 Session</label><label><input type="radio" name="run-session-mode" checked={launchMode === 'reuse'} onChange={() => setLaunchMode('reuse')} /> 复用当前 Task 的 Session</label>{launchMode === 'reuse' && <><p>仅列出本 Task 历史 Run 使用过、当前账号拥有、绑定与指派一致且列表显示空闲的会话；服务端将再次校验。若拒绝复用，请刷新并明确选择下一步，不会自动改为新建。</p>{sessions.feedback}<label>选择 Session<select value={reuseSessionId} onChange={event => setReuseSessionId(event.target.value)} required><option value="">请选择会话</option>{candidates.map(session => <option key={session.id} value={session.id}>{session.title} ({session.id})：{session.binding.workspaceId} / {session.binding.agent.workerId} / {session.binding.agent.agentKey} / {session.binding.modelId ?? '默认模型'}</option>)}</select></label>{sessions.ready && !candidates.length && <p role="status">暂无可复用的会话。请检查会话状态或明确选择新建。</p>}</>}</fieldset><Button type="submit" disabled={busy || reconciling || !runs.ready || !!snapshot || !!storageError || !!reviewSnapshot || !!reviewStorageError || !!decisionSnapshot || !!decisionStorageError || !!activeRun || !task.assignee || !prompt.trim() || (launchMode === 'reuse' && (!sessions.ready || !candidates.some(session => session.id === reuseSessionId)))}>启动新 Run</Button></form>}
    {!runs.data && task.activeRun && <p role="status">任务仍有运行中的 Run #{task.activeRun.attempt}；列表暂不可用，新执行已暂停，请刷新确认。</p>}
    {completionStorageError && <p role="alert">{completionStorageError}<Button variant="outline" onClick={refresh}>重新读取完成请求</Button></p>}
    {completionSnapshot && <div role="status"><p>{completionRejection === completionSnapshot.requestId ? '原完成请求已被服务端明确拒绝：任务版本已变更。请重新读取任务后核对成果，再发起新请求。' : '原完成请求结果尚未确认；请重试原请求以取回回执，不要修改摘要或使用新请求。'}</p>{completionRejection === completionSnapshot.requestId ? <Button variant="outline" disabled={!writable || busy || !!completionStorageError} onClick={() => { try { completion.discardRejected(completionSnapshot.requestId); setCompletionSnapshot(null); setCompletionRejection(null); setError(''); setReconciling(true); reconcile(completionSnapshot.version); runs.reload() } catch (cause) { setCompletionStorageError(accountError(cause)) } }}>放弃已拒绝请求并重新核对</Button> : <Button variant="outline" disabled={!writable || busy || !!completionStorageError} onClick={() => void complete(true)}>重试原完成请求</Button>}</div>}
    {writable && !reconciling && !completionSnapshot && !completionStorageError && task.status === 'in_progress' && latest?.status === 'succeeded' && !activeRun && noReview && <form onSubmit={event => { event.preventDefault(); void complete() }}><h4>显式提交完成</h4><p>Run 成功不等于 Task 完成。仅在没有强制审查时提交；服务端将检查最新 Run、版本、权限及当前策略。</p><label>成果摘要<textarea value={summary} onChange={event => setSummary(event.target.value)} maxLength={16000} required /></label><label>证据引用（每行一条，最多 20 条）<textarea value={evidence} onChange={event => setEvidence(event.target.value)} /></label><Button type="submit" disabled={busy || !summary.trim() || evidence.split('\n').filter(line => line.trim()).length > 20}>提交完成</Button></form>}
    {writable && !reconciling && !reviewSnapshot && !reviewStorageError && !decisionSnapshot && !decisionStorageError && runs.data && task.status === 'in_progress' && latest?.status === 'succeeded' && !activeRun && (policy === 'human' || policy === 'multi-stage') && <form onSubmit={event => { event.preventDefault(); void submitHumanReview() }}><h4>{policy === 'multi-stage' ? '提交多阶段审查' : '提交人工审查'}</h4><p>仅提交成果与证据，不能自行作出审查决定；{policy === 'multi-stage' ? '多阶段审查需两位彼此独立的获权参与者先后批准，任何一段要求修改都会退回实施。' : '获授权的其他参与者将在任务详情中处理。'}</p><label>成果摘要<textarea value={summary} onChange={event => setSummary(event.target.value)} maxLength={16000} required /></label><label>证据引用（每行一条，最多 20 条）<textarea value={evidence} onChange={event => setEvidence(event.target.value)} /></label><Button type="submit" disabled={busy || !summary.trim() || evidence.split('\n').filter(line => line.trim()).length > 20}>提交人工审查</Button></form>}
    {writable && task.status === 'in_progress' && latest?.status === 'succeeded' && !activeRun && !noReview && policy !== 'human' && <p role="status">此任务需审查；请勿通过普通状态修改跳过审查。此策略的审查提交和决定入口尚未接入。</p>}
    {task.status === 'in_review' && task.currentReviewId && <><p role="status">审查请求 {task.currentReviewId} 待处理，任务尚未完成。{review?.stageCount ? `当前处于第 ${review.stageIndex}/${review.stageCount} 阶段，前序阶段批准后才会进入下一阶段。` : ''}</p>{reviews.feedback}{review && <p>提交者：{review.actor}；Run：{review.taskRunId}；提交时间：{review.requestedAt}{review.stageCount ? `；阶段：${review.stageIndex}/${review.stageCount}` : ''}。请先在关联会话与任务活动中核对成果与证据。</p>}{review && !mayDecide && <p role="status">提交者本人不能审查自己的成果；请由另一位获授权的项目所有者或管理者处理。</p>}{review && mayDecide && <form onSubmit={event => { event.preventDefault(); void decideHumanReview('changes_requested') }}><h4>{review.stageCount ? `第 ${review.stageIndex}/${review.stageCount} 阶段审查决定` : '人工审查决定'}</h4><p>提交者本人不能审查；服务端将再次校验当前身份、任务版本及最新成功 Run。{review.stageCount ? '同一段链路中已批准过前序阶段的参与者不能再决定后续阶段。' : ''}批准会{review.stageCount && review.stageIndex! < review.stageCount ? '推进下一阶段' : '完成 Task'}，要求修改会退回实施。</p><label>要求修改的理由<textarea value={decisionReason} onChange={event => setDecisionReason(event.target.value)} maxLength={2000} /></label><Button type="submit" disabled={busy || reconciling || !!decisionSnapshot || !!decisionStorageError || !runs.ready || !reviews.ready || !!activeRun || latest?.status !== 'succeeded' || !decisionReason.trim()}>要求修改</Button><Button type="button" variant="outline" disabled={busy || reconciling || !!decisionSnapshot || !!decisionStorageError || !runs.ready || !reviews.ready || !!activeRun || latest?.status !== 'succeeded'} onClick={() => void decideHumanReview('approved')}>{review.stageCount && review.stageIndex! < review.stageCount ? '批准并进入下一阶段' : '批准并完成'}</Button></form>}</>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {runId && runs.ready && !selectedRun && <p role="status">当前任务的执行记录中未找到链接指定的 Run。请核对任务与运行链接。</p>}
    {runs.data && <><p>{runs.data.length ? `执行记录 ${runs.data.length} 条` : '暂无 Run。可以在任务执行指派准备就绪后启动。'}</p><ol>{runs.data.map(run => <li className="account-row task-run-row" key={run.id} data-run-id={run.id} aria-current={selectedRun === run ? 'true' : undefined} tabIndex={selectedRun === run ? -1 : undefined} ref={selectedRun === run ? selectedRow : undefined}><h4>第 {run.attempt} 次执行：{statusLabels[run.status]}</h4>{selectedRun === run && <p>链接指定的执行记录</p>}<p>Session：{run.sessionId}；{run.startedAt ? `启动：${run.startedAt}` : '等待启动'}；{run.finishedAt ? `结束：${run.finishedAt}` : '尚未结束'}</p>{run.resultSummary && <p>结果：{run.resultSummary}</p>}{run.failure && <p role="alert">故障：{run.failure.code}：{run.failure.message}</p>}<Button variant="outline" onClick={() => selectSession(run.sessionId)}>查看关联会话</Button>{writable && ['pending', 'running', 'cancelling'].includes(run.status) && <Button variant="outline" disabled={busy} onClick={() => void cancel(run)}>取消本次 Run</Button>}</li>)}</ol></>}
  </section>
}
