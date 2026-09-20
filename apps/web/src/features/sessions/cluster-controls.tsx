import { useEffect, useRef, useState } from 'react'
import type { Api } from '../../api/client'
import type { SessionDTO } from '../../api/dto'
import type { PendingApproval, QueuedItem } from '../../api/journal'
import { randomId } from '../../lib/random.ts'
import { Button } from '../../components/ui/button.tsx'

interface ActionState { commandId: string; operationId: string; status: 'sending' | 'pending' | 'accepted' | 'error' | 'rejected'; message: string; decision?: 'approve' | 'deny' }
/** HTTP acceptance is not execution completion; journal events remain authoritative. */
export function ClusterControls({ api, session, activeTurnId, queuedItems, pendingApprovals, enabled }: {
  api: Api; session: SessionDTO; activeTurnId: string | null; queuedItems: QueuedItem[]; pendingApprovals: PendingApproval[]; enabled: boolean
}) {
  const [actions, setActions] = useState<Record<string, ActionState>>({})
  const state = useRef(actions)
  const alive = useRef(true)
  const update = (key: string, action: ActionState) => {
    if (!alive.current) return
    state.current = { ...state.current, [key]: action }; setActions(state.current)
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const approvals = new Set(pendingApprovals.map(item => item.approvalId))
    setActions(current => {
      const next = Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith('approval:') || approvals.has(key.slice('approval:'.length))))
      state.current = next
      return next
    })
  }, [pendingApprovals.map(item => item.approvalId).join(',')])
  useEffect(() => {
    let disposed = false
    const timer = setInterval(() => {
      for (const [key, action] of Object.entries(state.current)) {
        if (action.status !== 'pending') continue
        void api.command(action.commandId).then(receipt => {
          if (disposed || state.current[key] !== action) return
          if (receipt.status === 'accepted') update(key, { ...action, status: 'accepted', message: 'Worker 已受理，等待历史确认执行结果。' })
          if (receipt.status === 'rejected') update(key, { ...action, status: 'rejected', message: receipt.receipt?.error?.message || 'Worker 已拒绝请求，可重试。' })
        }).catch(() => { /* Keep the identity while receipt delivery is uncertain. */ })
      }
    }, 1500)
    return () => { disposed = true; clearInterval(timer) }
  }, [api])
  const run = async (key: string, send: (commandId: string, operationId: string) => Promise<{ commandId: string }>, decision?: 'approve' | 'deny', capability: 'write' | 'control' = 'control') => {
    const previous = state.current[key]
    const permitted = capability === 'write' ? (session.access?.canWrite ?? session.canSend) : (session.access?.canControl ?? session.canManage)
    if (!enabled || !permitted || (previous && ['sending', 'pending', 'accepted'].includes(previous.status))) return
    if (previous?.status === 'error' && previous.decision !== decision) return
    const action: ActionState = { decision, commandId: previous?.status === 'error' ? previous.commandId : randomId(), operationId: previous?.status === 'error' ? previous.operationId : randomId(), status: 'sending', message: '正在提交…' }
    update(key, action)
    try {
      const result = await send(action.commandId, action.operationId)
      if (result.commandId !== action.commandId) throw new Error('响应身份不匹配，请核对后重试。')
      update(key, { ...action, status: 'pending', message: '请求已提交，等待 Worker 回执。' })
    } catch (error) {
      update(key, { ...action, status: 'error', message: error instanceof Error ? error.message : '请求失败，重试将复用原请求身份。' })
    }
  }
  const canControl = session.access?.canControl ?? session.canManage
  const canWrite = session.access?.canWrite ?? session.canSend
  const blocked = (key: string, capability: 'write' | 'control' = 'control') => !enabled || !(capability === 'write' ? canWrite : canControl) || Boolean(actions[key] && ['sending', 'pending', 'accepted'].includes(actions[key].status))
  const compactBlocked = !enabled || !session.canManage || Boolean(actions.compact && ['sending', 'pending'].includes(actions.compact.status))
  const compact = () => {
    const previous = state.current.compact
    if (!enabled || !session.canManage || (previous && ['sending', 'pending'].includes(previous.status))) return
    const action: ActionState = {
      commandId: previous?.status === 'error' ? previous.commandId : randomId(),
      operationId: previous?.status === 'error' ? previous.operationId : randomId(),
      status: 'sending', message: '正在提交…',
    }
    update('compact', action)
    void api.invokeRuntimeCommand(session.id, { commandId: action.commandId, operationId: action.operationId, name: 'compact' }).then(result => {
      if (result.commandId !== action.commandId) throw new Error('响应身份不匹配，请核对后重试。')
      update('compact', { ...action, status: 'pending', message: '压缩请求已提交，等待 Worker 执行。' })
    }).catch(error => update('compact', { ...action, status: 'error', message: error instanceof Error ? error.message : '请求失败，重试将复用原请求身份。' }))
  }
  const feedback = (key: string) => actions[key] && <p role={['error', 'rejected'].includes(actions[key].status) ? 'alert' : 'status'} className="break-words text-xs text-muted-foreground">{actions[key].message}</p>
  return <section aria-label="会话运行控制" className="max-h-[35dvh] shrink-0 space-y-2 overflow-auto border-t border-border px-3 py-2 sm:px-6">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={!activeTurnId || blocked(`stop:${activeTurnId}`)} onClick={() => { if (activeTurnId) void run(`stop:${activeTurnId}`, commandId => api.stopTurn(session.id, activeTurnId, commandId)) }}>停止当前回合</Button>
      <Button size="sm" variant="outline" disabled={compactBlocked || Boolean(activeTurnId) || queuedItems.length > 0} onClick={compact}>{actions.compact && ['sending', 'pending'].includes(actions.compact.status) ? '正在压缩上下文…' : actions.compact?.status === 'error' ? '重试压缩上下文' : '压缩上下文'}</Button>
    </div>
    {activeTurnId && feedback(`stop:${activeTurnId}`)}{feedback('compact')}
    {queuedItems.length > 0 && <div><h2 className="text-xs font-medium">排队消息（{queuedItems.length}）</h2><ol className="space-y-2">{queuedItems.map(item => <li key={item.messageId} className="text-sm"><div className="flex items-start gap-2"><p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{item.content}</p><Button size="sm" variant="ghost" disabled={blocked(`cancel:${item.commandId}`, 'write')} onClick={() => { void run(`cancel:${item.commandId}`, commandId => api.cancelQueued(session.id, item.commandId, commandId), undefined, 'write') }}>取消排队</Button></div>{feedback(`cancel:${item.commandId}`)}</li>)}</ol></div>}
    {pendingApprovals.map(approval => <div key={approval.approvalId} className="space-y-2 rounded-md border border-border p-3"><h2 className="text-sm font-medium">待审批操作</h2>{approval.reason && <p className="text-sm">{approval.reason}</p>}<pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(approval.action, null, 2)}</pre><div className="flex gap-2">{(['approve', 'deny'] as const).map(decision => <Button key={decision} size="sm" variant="outline" disabled={blocked(`approval:${approval.approvalId}`) || (actions[`approval:${approval.approvalId}`]?.status === 'error' && actions[`approval:${approval.approvalId}`]?.decision !== decision)} onClick={() => { void run(`approval:${approval.approvalId}`, commandId => api.resolveApproval(session.id, approval.approvalId, { commandId, decision }), decision) }}>{decision === 'approve' ? '批准' : '拒绝'}</Button>)}</div>{feedback(`approval:${approval.approvalId}`)}</div>)}
  </section>
}
