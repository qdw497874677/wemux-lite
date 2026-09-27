import { useEffect, useRef, useState } from 'react'
import { File, ShieldAlert, Terminal } from 'lucide-react'
import type { Api } from '../../api/client.ts'
import type { SessionDTO } from '../../api/dto.ts'
import type { PendingApproval } from '../../api/journal.ts'
import { Badge } from '../../components/ui/badge.tsx'
import { Button } from '../../components/ui/button.tsx'
import { randomId } from '../../lib/random.ts'
import { approvalPresentation } from './approval-presentation.ts'

type ApprovalActionState = {
  commandId: string
  status: 'sending' | 'pending' | 'accepted' | 'error' | 'rejected'
  message: string
  decision: 'approve' | 'deny'
}

export function PendingApprovalPanel({ api, session, pendingApprovals, enabled }: {
  api: Api
  session: SessionDTO
  pendingApprovals: PendingApproval[]
  enabled: boolean
}) {
  const [actions, setActions] = useState<Record<string, ApprovalActionState>>({})
  const state = useRef(actions)
  const alive = useRef(true)
  const update = (key: string, action: ApprovalActionState) => {
    if (!alive.current) return
    state.current = { ...state.current, [key]: action }
    setActions(state.current)
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const approvals = new Set(pendingApprovals.map(item => item.approvalId))
    setActions(current => {
      const next = Object.fromEntries(Object.entries(current).filter(([key]) => approvals.has(key)))
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
          if (receipt.status === 'accepted') update(key, { ...action, status: 'accepted', message: 'Worker ，。' })
          if (receipt.status === 'rejected') update(key, { ...action, status: 'rejected', message: receipt.receipt?.error?.message || 'Worker ，。' })
        }).catch(() => { /* Keep pending while receipt delivery is uncertain. */ })
      }
    }, 1500)
    return () => { disposed = true; clearInterval(timer) }
  }, [api])
  const resolve = async (approval: PendingApproval, decision: 'approve' | 'deny') => {
    const key = approval.approvalId
    const previous = state.current[key]
    const permitted = session.access?.canControl ?? session.canManage
    if (!enabled || !permitted || (previous && ['sending', 'pending', 'accepted'].includes(previous.status))) return
    if (previous?.status === 'error' && previous.decision !== decision) return
    const action: ApprovalActionState = {
      decision,
      commandId: previous?.status === 'error' ? previous.commandId : randomId(),
      status: 'sending',
      message: '…',
    }
    update(key, action)
    try {
      const result = await api.resolveApproval(session.id, approval.approvalId, { commandId: action.commandId, decision })
      if (result.commandId !== action.commandId) throw new Error('，。')
      update(key, { ...action, status: 'pending', message: '， Worker 。' })
    } catch (error) {
      update(key, { ...action, status: 'error', message: error instanceof Error ? error.message : '，。' })
    }
  }
  if (pendingApprovals.length === 0) return null
  const canControl = session.access?.canControl ?? session.canManage
  return <section aria-label="" className="space-y-2 border-b border-border bg-card/70 px-3 py-2 sm:px-4">
    <div className="flex items-center gap-2"><h2 className="text-xs font-medium text-warning"></h2><Badge variant="warning" className="px-2 py-0.5 text-[10px] tabular-nums">{pendingApprovals.length}</Badge></div>
    {pendingApprovals.map(approval => {
      const presentation = approvalPresentation(approval.action, approval.reason)
      const action = actions[approval.approvalId]
      const blocked = !enabled || !canControl || Boolean(action && ['sending', 'pending', 'accepted'].includes(action.status))
      return <article key={approval.approvalId} className="space-y-2.5 rounded-xl border border-warning-border bg-warning-surface px-3 py-3" data-approval-kind={presentation.kind}>
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-warning/15 text-warning">{presentation.kind === 'command' ? <Terminal className="size-4" aria-hidden="true" /> : presentation.kind === 'files' ? <File className="size-4" aria-hidden="true" /> : <ShieldAlert className="size-4" aria-hidden="true" />}</span>
          <div className="min-w-0 flex-1"><h3 className="text-sm font-medium text-foreground">{presentation.title}</h3>
            {presentation.kind === 'command' && <div className="mt-2 space-y-1.5"><pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background/80 px-3 py-2 font-mono text-xs text-foreground" aria-label="">{presentation.command}</pre>{presentation.cwd && <p className="truncate font-mono text-[11px] text-muted-foreground" title={presentation.cwd}>cwd: {presentation.cwd}</p>}</div>}
            {presentation.kind === 'files' && <ul className="mt-2 space-y-1" aria-label="">{presentation.paths.map(path => <li key={path} className="flex min-w-0 items-center gap-2 rounded-md bg-background/65 px-2.5 py-1.5"><File className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /><code className="min-w-0 break-all text-xs text-foreground">{path}</code></li>)}</ul>}
            {presentation.kind === 'summary' && <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-5 text-muted-foreground">{presentation.summary}</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2"><Button size="xs" disabled={blocked || (action?.status === 'error' && action.decision !== 'approve')} onClick={() => { void resolve(approval, 'approve') }}></Button><Button size="xs" variant="outline" disabled={blocked || (action?.status === 'error' && action.decision !== 'deny')} onClick={() => { void resolve(approval, 'deny') }}></Button><span className="text-[11px] text-muted-foreground"></span></div>
        {action && <p role={['error', 'rejected'].includes(action.status) ? 'alert' : 'status'} className="break-words text-xs text-muted-foreground">{action.message}</p>}
      </article>
    })}
  </section>
}
