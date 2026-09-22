import { useEffect, useMemo, useRef, useState } from 'react'

import type { Api } from '../../api/client.ts'
import type { SessionDTO } from '../../api/dto.ts'
import { useSession } from '../../api/use-session.ts'
import { TimelineEntry, Composer, OptimisticMessages } from './conversation.tsx'
import { ClusterControls } from './cluster-controls.tsx'
import { SubmissionController } from './submission.ts'
import { Badge } from '../../components/ui/badge.tsx'
import { Button } from '../../components/ui/button.tsx'
import { runtimeStateLabel } from '../../lib/display.ts'
import { randomId } from '../../lib/random.ts'

export type SessionPresentation = 'canvas-summary' | 'canvas-interactive' | 'focus' | 'run'

type Props = {
  api: Api
  session: SessionDTO
  presentation: SessionPresentation
  projectPath: string
  workerLabel: string
  onOpenFocus?: () => void
}

export function SessionSurface({ api, session, presentation, projectPath, workerLabel, onOpenFocus }: Props) {
  const [revision, setRevision] = useState(0)
  const history = useSession(api, session.id, revision)
  const [nearBottom, setNearBottom] = useState(true)
  const timelineRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { if (nearBottom) timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight, behavior: 'smooth' }) }, [history.timeline.length, nearBottom])
  const controller = useMemo(() => new SubmissionController(api, session.id, () => { setRevision(value => value + 1); return randomId() }), [api, session.id])
  useEffect(() => () => controller.dispose(), [controller])
  const confirmedIds = history.messages.map(message => message.id)
  const canSend = session.access?.canWrite !== false && session.sendCapability?.allowed === true && history.freshness?.status === 'synced' && !history.error
  const blockedReason = session.access?.canWrite === false ? '当前账号只有查看权限' : session.sendCapability?.allowed === false ? session.sendCapability.reason : history.error || '正在核对会话状态'
  const currentSession = session
  const interactive = presentation !== 'canvas-summary'
  const controls = presentation === 'focus' || presentation === 'run'

  return <section className={`session-surface session-surface-${presentation}`} data-session-id={session.id}>
    <header className="session-surface-header">
      <div className="min-w-0"><span className="eyebrow">{presentation.startsWith('canvas') ? '画布会话' : '专注会话'}</span><h2 className="truncate">{session.title}</h2><p className="truncate text-xs text-muted-foreground">{workerLabel} · {session.agentKey} / {session.modelId || '默认模型'}</p></div>
      <div className="session-surface-actions"><Badge variant={session.runtimeState === 'running' ? 'success' : 'outline'}>{runtimeStateLabel[session.runtimeState]}</Badge>{presentation === 'canvas-interactive' && onOpenFocus ? <Button size="sm" variant="outline" onClick={onOpenFocus}>进入专注视图</Button> : null}</div>
    </header>
    <div ref={timelineRef} className="session-surface-timeline" aria-live="polite" onScroll={event => { const element = event.currentTarget; setNearBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 96) }}>
      {!history.timeline.length && <p className="py-8 text-center text-sm text-muted-foreground">{history.checkedAt ? canSend ? '暂无消息，可以开始对话。' : blockedReason : '正在加载会话历史…'}</p>}
      {history.timeline.map(entry => <TimelineEntry key={entry.id} entry={entry} />)}
      <OptimisticMessages controller={controller} confirmedIds={confirmedIds} />
    </div>
    {!nearBottom && <button type="button" className="session-surface-jump nodrag nopan" onClick={() => { const element = timelineRef.current; element?.scrollTo({ top: element.scrollHeight, behavior: 'smooth' }) }}>跳到最新消息</button>}
    {history.stream !== 'live' && <p className="session-surface-signal">实时更新正在重连，历史仍会继续补传。</p>}
    {interactive && <div className="session-surface-composer nodrag nopan nowheel"><Composer controller={controller} session={currentSession} canSend={canSend} blockedReason={blockedReason} confirmedIds={confirmedIds} /></div>}
    {controls && <ClusterControls api={api} session={currentSession} activeTurnId={history.activeTurnId} queuedItems={history.queuedItems} pendingApprovals={history.pendingApprovals} enabled={canSend} />}
    {controls && <footer className="session-surface-footer">{projectPath}</footer>}
  </section>
}
