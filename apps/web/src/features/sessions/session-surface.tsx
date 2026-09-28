import { useEffect, useMemo, useState } from 'react'

import type { Api } from '../../api/client.ts'
import type { AgentDTO, SessionDTO } from '../../api/dto.ts'
import { useSession } from '../../api/use-session.ts'
import { TimelineEntry, Composer, OptimisticMessages, useMessageActions } from './conversation.tsx'
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '../../components/ai-elements/conversation.tsx'
import { Suggestion, Suggestions } from '../../components/ai-elements/suggestion.tsx'
import { ClusterControls } from './cluster-controls.tsx'
import { PendingApprovalPanel } from './pending-approval-panel.tsx'
import { SubmissionController } from './submission.ts'
import { applySessionSuggestion, emptySessionSuggestions } from './suggestions.ts'
import { Badge } from '../../components/ui/badge.tsx'
import { Button } from '../../components/ui/button.tsx'
import { runtimeStateLabel } from '../../lib/display.ts'
import { randomId } from '../../lib/random.ts'
import { timelineDateLabel } from '../../lib/conversation-timeline.ts'

export type SessionPresentation = 'canvas-summary' | 'canvas-interactive' | 'focus' | 'run'

type Props = {
  api: Api
  session: SessionDTO
  presentation: SessionPresentation
  projectPath: string
  workerLabel: string
  agent?: AgentDTO
  onOpenFocus?: () => void
}

export function SessionSurface({ api, session, presentation, projectPath, workerLabel, agent, onOpenFocus }: Props) {
  const [revision, setRevision] = useState(0)
  const history = useSession(api, session.id, revision)
  const controller = useMemo(() => new SubmissionController(api, session.id, () => { setRevision(value => value + 1); return randomId() }), [api, session.id])
  useEffect(() => () => controller.dispose(), [controller])
  const confirmedIds = history.messages.map(message => message.id)
  const canSend = session.access?.canWrite !== false && session.sendCapability?.allowed === true && history.freshness?.status === 'synced' && !history.error
  const blockedReason = session.access?.canWrite === false ? '当前账号只有查看权限' : session.sendCapability?.allowed === false ? session.sendCapability.reason : history.error || '正在核对会话状态'
  const currentSession = session
  const interactive = presentation !== 'canvas-summary'
  const controls = presentation === 'focus' || presentation === 'run'
  const chooseSuggestion = (suggestion: string) => applySessionSuggestion(controller, document.getElementById(`session-prompt-${session.id}`), suggestion)
  const { hiddenMessageIds, localNotice, messageActions } = useMessageActions(controller, session.id, canSend)
  const focusComposer = () => window.requestAnimationFrame(() => document.getElementById(`session-prompt-${session.id}`)?.focus())
  const planActions = {
    canAct: canSend,
    onApprove: () => { void controller.resendAsNew('批准执行上述计划'); focusComposer() },
    onModify: (text: string) => { controller.prefillForEdit(text); focusComposer() },
  }
  const visibleTimeline = history.timeline.filter(entry => !hiddenMessageIds.has(entry.id))
  const datedTimeline = visibleTimeline.map(entry => ({ timestamp: entry.kind === 'message' || entry.kind === 'tool' ? entry.timestamp : undefined }))

  return <section className={`session-surface session-surface-${presentation}`} data-session-id={session.id}>
    <header className="session-surface-header">
      <div className="min-w-0"><span className="eyebrow">{presentation.startsWith('canvas') ? '画布会话' : '专注会话'}</span><h2 className="truncate">{session.title}</h2><p className="truncate text-xs text-muted-foreground">{workerLabel} · {session.agentKey} / {session.modelId || '默认模型'}</p></div>
      <div className="session-surface-actions"><Badge variant={session.runtimeState === 'running' ? 'success' : 'outline'}>{runtimeStateLabel[session.runtimeState]}</Badge>{presentation === 'canvas-interactive' && onOpenFocus ? <Button size="sm" variant="outline" onClick={onOpenFocus}>进入专注视图</Button> : null}</div>
    </header>
    <Conversation className="session-surface-timeline conversation-timeline" aria-live="polite"><ConversationContent className="conversation-content gap-3 px-3 py-3 sm:px-4 sm:py-4">
      {!history.timeline.length && <ConversationEmptyState title={history.checkedAt ? canSend ? '暂无消息，可以开始对话。' : blockedReason : '正在加载会话历史…'}>{history.checkedAt && canSend ? <div className="flex max-w-[var(--chat-max-width)] flex-col items-center gap-3"><div className="space-y-1"><h3 className="text-sm font-medium">暂无消息，可以开始对话。</h3><p className="text-xs leading-5 text-muted-foreground/60">选择一个建议，或在下方输入你的问题。</p></div><Suggestions className="justify-center">{emptySessionSuggestions.map(suggestion => <Suggestion key={suggestion} suggestion={suggestion} onClick={() => chooseSuggestion(suggestion)}>{suggestion}</Suggestion>)}</Suggestions></div> : <h3 className="text-sm font-medium">{history.checkedAt ? blockedReason : '正在加载会话历史…'}</h3>}</ConversationEmptyState>}
      {visibleTimeline.map((entry, index) => {
        const dateLabel = timelineDateLabel(datedTimeline, index)
        return <div key={entry.id} className="contents">{dateLabel && <div className="flex items-center gap-3 py-2" role="separator" aria-label={dateLabel}><span className="h-px flex-1 bg-border/60" /><span className="shrink-0 text-xs text-muted-foreground/60">{dateLabel}</span><span className="h-px flex-1 bg-border/60" /></div>}<TimelineEntry entry={entry} api={api} sessionId={session.id} messageActions={messageActions} planActions={planActions} /></div>
      })}
      {localNotice && <p role="status" className="text-center text-xs text-muted-foreground">{localNotice}</p>}
      <OptimisticMessages api={api} sessionId={session.id} controller={controller} confirmedIds={confirmedIds} hiddenMessageIds={hiddenMessageIds} messageActions={messageActions} />
    </ConversationContent><ConversationScrollButton className="nodrag nopan" /></Conversation>
    {history.stream !== 'live' && <p className="session-surface-signal">实时更新正在重连，历史仍会继续补传。</p>}
    {controls && <ClusterControls api={api} session={currentSession} queuedItems={history.queuedItems} enabled={canSend} />}
    {interactive && <div className="session-surface-composer nodrag nopan nowheel"><PendingApprovalPanel api={api} session={currentSession} pendingApprovals={history.pendingApprovals} enabled={canSend} /><Composer api={api} controller={controller} session={currentSession} agent={agent} activeTurnId={history.activeTurnId} canSend={canSend} blockedReason={blockedReason} confirmedIds={confirmedIds} /></div>}
    {controls && <footer className="session-surface-footer">{projectPath}</footer>}
  </section>
}
