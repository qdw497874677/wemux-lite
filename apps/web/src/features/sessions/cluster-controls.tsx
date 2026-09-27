import { useEffect, useRef, useState } from 'react'
import type { Api } from '../../api/client'
import type { SessionDTO } from '../../api/dto'
import type { QueuedItem } from '../../api/journal'
import { randomId } from '../../lib/random.ts'
import { Button } from '../../components/ui/button.tsx'

interface ActionState { commandId: string; operationId: string; status: 'sending' | 'pending' | 'accepted' | 'error' | 'rejected'; message: string }
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
      if (result.commandId !== next.commandId) throw new Error('，。')
    } catch {
      update({ ...next, status: 'error' })
    }
  }
  return { action, compact }
}

/** HTTP acceptance is not execution completion; journal events remain authoritative. */
export function ClusterControls({ api, session, queuedItems, enabled }: {
  api: Api; session: SessionDTO; queuedItems: QueuedItem[]; enabled: boolean
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
    let disposed = false
    const timer = setInterval(() => {
      for (const [key, action] of Object.entries(state.current)) {
        if (action.status !== 'pending') continue
        void api.command(action.commandId).then(receipt => {
          if (disposed || state.current[key] !== action) return
          if (receipt.status === 'accepted') update(key, { ...action, status: 'accepted', message: 'Worker ，。' })
          if (receipt.status === 'rejected') update(key, { ...action, status: 'rejected', message: receipt.receipt?.error?.message || 'Worker ，。' })
        }).catch(() => { /* Keep the identity while receipt delivery is uncertain. */ })
      }
    }, 1500)
    return () => { disposed = true; clearInterval(timer) }
  }, [api])
  const run = async (key: string, send: (commandId: string, operationId: string) => Promise<{ commandId: string }>) => {
    const previous = state.current[key]
    const permitted = session.access?.canWrite ?? session.canSend
    if (!enabled || !permitted || (previous && ['sending', 'pending', 'accepted'].includes(previous.status))) return
    const action: ActionState = { commandId: previous?.status === 'error' ? previous.commandId : randomId(), operationId: previous?.status === 'error' ? previous.operationId : randomId(), status: 'sending', message: '…' }
    update(key, action)
    try {
      const result = await send(action.commandId, action.operationId)
      if (result.commandId !== action.commandId) throw new Error('，。')
      update(key, { ...action, status: 'pending', message: '， Worker 。' })
    } catch (error) {
      update(key, { ...action, status: 'error', message: error instanceof Error ? error.message : '，。' })
    }
  }
  const canWrite = session.access?.canWrite ?? session.canSend
  const blocked = (key: string) => !enabled || !canWrite || Boolean(actions[key] && ['sending', 'pending', 'accepted'].includes(actions[key].status))
  const feedback = (key: string) => actions[key] && <p role={['error', 'rejected'].includes(actions[key].status) ? 'alert' : 'status'} className="break-words text-xs text-muted-foreground">{actions[key].message}</p>
  if (queuedItems.length === 0) return null
  return <section aria-label="" className="max-h-[35dvh] shrink-0 space-y-2 overflow-auto border-t border-border px-3 py-2 sm:px-6">
    <div><h2 className="text-xs font-medium">（{queuedItems.length}）</h2><ol className="space-y-2">{queuedItems.map(item => <li key={item.messageId} className="text-sm"><div className="flex items-start gap-2"><p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{item.content}</p><Button size="sm" variant="ghost" disabled={blocked(`cancel:${item.commandId}`)} onClick={() => { void run(`cancel:${item.commandId}`, commandId => api.cancelQueued(session.id, item.commandId, commandId)) }}></Button></div>{feedback(`cancel:${item.commandId}`)}</li>)}</ol></div>
  </section>
}
