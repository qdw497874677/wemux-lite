import { useEffect, useRef, useState } from 'react'
import type { Api } from '../../api/client'
import type { SessionDTO } from '../../api/dto'
import type { PendingApproval, QueuedItem } from '../../api/journal'
import { randomId } from '../../lib/random.ts'
import { Button } from '../../components/ui/button.tsx'

interface ActionState { commandId: string; operationId: string; status: 'sending' | 'pending' | 'accepted' | 'error' | 'rejected'; message: string; decision?: 'approve' | 'deny' }
export interface CompactActionState { commandId: string; operationId: string; status: 'pending' | 'error' }

export function useCompactAction(api: Api | undefined, sessionId: string) {
  const [action, setAction] = useState<CompactActionState | null>(null)
  const state = useRef(action)
  const update = (next: CompactActionState | null) => { state.current = next; setAction(next) }
  useEffect(() => { update(null) }, [sessionId])
  useEffect(() => {
    if (!api) return
    let disposed = false
    const timer = setInterval(() => {
      const current = state.current
      if (current?.status !== 'pending') return
      void api.command(current.commandId).then(receipt => {
        if (disposed || state.current !== current) return
        if (receipt.status === 'accepted') update(null)
        if (receipt.status === 'rejected') update({ ...current, status: 'error' })
      }).catch(() => { /* Keep pending while receipt delivery is uncertain. */ })
    }, 1500)
    return () => { disposed = true; clearInterval(timer) }
  }, [api])
  const compact = async () => {
    const previous = state.current
    if (!api || previous?.status === 'pending') return
    const next: CompactActionState = {
      commandId: previous?.status === 'error' ? previous.commandId : randomId(),
      operationId: previous?.status === 'error' ? previous.operationId : randomId(),
      status: 'pending',
    }
    update(next)
    try {
      const result = await api.invokeRuntimeCommand(sessionId, { commandId: next.commandId, operationId: next.operationId, name: 'compact' })
      if (result.commandId !== next.commandId) throw new Error('响应身份不匹配，请核对后重试。')
    } catch {
      update({ ...next, status: 'error' })
    }
  }
  return { action, compact }
}

/** HTTP acceptance is not execution completion; journal events remain authoritative. */
export function ClusterControls({ api, session, queuedItems, pendingApprovals, enabled }: {
  api: Api; session: SessionDTO; queuedItems: QueuedItem[]; pendingApprovals: PendingApproval[]; enabled: boolean
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
  const feedback = (key: string) => actions[key] && <p role={['error', 'rejected'].includes(actions[key].status) ? 'alert' : 'status'} className="break-words text-xs text-muted-foreground">{actions[key].message}</p>
  if (queuedItems.length === 0 && pendingApprovals.length === 0) return null
  return <section aria-label="会话运行控制" className="max-h-[35dvh] shrink-0 space-y-2 overflow-auto border-t border-border px-3 py-2 sm:px-6">
    {queuedItems.length > 0 && <div><h2 className="text-xs font-medium">排队消息（{queuedItems.length}）</h2><ol className="space-y-2">{queuedItems.map(item => <li key={item.messageId} className="text-sm"><div className="flex items-start gap-2"><p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{item.content}</p><Button size="sm" variant="ghost" disabled={blocked(`cancel:${item.commandId}`, 'write')} onClick={() => { void run(`cancel:${item.commandId}`, commandId => api.cancelQueued(session.id, item.commandId, commandId), undefined, 'write') }}>取消排队</Button></div>{feedback(`cancel:${item.commandId}`)}</li>)}</ol></div>}
    {pendingApprovals.map(approval => <div key={approval.approvalId} className="space-y-2 rounded-md border border-border p-3"><h2 className="text-sm font-medium">待审批操作</h2>{approval.reason && <p className="text-sm">{approval.reason}</p>}<pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(approval.action, null, 2)}</pre><div className="flex gap-2">{(['approve', 'deny'] as const).map(decision => <Button key={decision} size="sm" variant="outline" disabled={blocked(`approval:${approval.approvalId}`) || (actions[`approval:${approval.approvalId}`]?.status === 'error' && actions[`approval:${approval.approvalId}`]?.decision !== decision)} onClick={() => { void run(`approval:${approval.approvalId}`, commandId => api.resolveApproval(session.id, approval.approvalId, { commandId, decision }), decision) }}>{decision === 'approve' ? '批准' : '拒绝'}</Button>)}</div>{feedback(`approval:${approval.approvalId}`)}</div>)}
  </section>
}
