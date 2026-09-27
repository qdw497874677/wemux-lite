import { Bot, ChevronDown, ChevronRight, Server } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { WorkerDTO } from '../../api/dto.ts'
import { Badge } from '../../components/ui/badge.tsx'
import { Button } from '../../components/ui/button.tsx'
import { cn } from '../../lib/utils.ts'
import { groupAgentsByWorker, type AgentPanelEntry } from './model.ts'

function AgentRow({ entry, onStart }: { entry: AgentPanelEntry; onStart: (entry: AgentPanelEntry) => void }) {
  const [expanded, setExpanded] = useState(false)
  const available = entry.availability.status === 'available'
  const reason = entry.availability.reason || (entry.availability.status === 'authentication-required' ? '需要完成认证' : '当前不可用')
  return <article className="rounded-lg border border-border bg-background/45">
    <div className="flex items-center gap-2 p-2.5">
      <button type="button" className="ring-focus flex min-w-0 flex-1 items-center gap-2 rounded-md text-left" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        {expanded ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
        <Bot className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{entry.displayName}</span>
      </button>
      <span title={available ? '可用' : reason}>
        <Badge variant={available ? 'success' : 'outline'} className={cn(!available && 'text-muted-foreground')}>{available ? '可用' : '不可用'}</Badge>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{entry.models.length} 个模型</span>
      <Button type="button" size="xs" variant="outline" disabled={!available} title={available ? '使用此智能体开始新对话' : reason} onClick={() => onStart(entry)}>新对话</Button>
    </div>
    {expanded && <div className="space-y-2 border-t border-border px-3 py-3">
      {!available && <p className="text-xs leading-5 text-muted-foreground">{reason}</p>}
      {entry.models.length ? <ul className="space-y-2 font-mono">{entry.models.map(model => <li key={model.modelId} className="grid gap-0.5 text-xs">
        <span className="text-foreground">{model.displayName}</span>
        <code className="break-all text-[11px] text-muted-foreground">{model.modelId}</code>
      </li>)}</ul> : <p className="text-xs text-muted-foreground">未报告模型</p>}
    </div>}
  </article>
}

export function AgentsPanel({ workers, onStartConversation }: { workers: WorkerDTO[]; onStartConversation: (entry: AgentPanelEntry) => void }) {
  const groups = useMemo(() => groupAgentsByWorker(workers), [workers])
  const total = groups.reduce((sum, group) => sum + group.agents.length, 0)
  return <section className="flex h-full min-h-0 flex-col" aria-label="智能体面板">
    <header className="shrink-0 border-b border-border px-3 py-3">
      <h2 className="text-sm font-semibold">智能体</h2>
      <p className="mt-1 text-xs text-muted-foreground">{groups.length} 个节点 · {total} 个智能体</p>
    </header>
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3">
      {groups.map(group => <section key={group.workerId} aria-labelledby={`agents-worker-${group.workerId}`}>
        <div className="mb-2 flex items-center gap-2 px-1">
          <Server className="size-4 text-muted-foreground" />
          <h3 id={`agents-worker-${group.workerId}`} className="min-w-0 flex-1 truncate text-xs font-semibold">{group.workerName}</h3>
          <span className="text-[11px] text-muted-foreground">{group.agents.length} 个</span>
        </div>
        <div className="space-y-2">{group.agents.map(entry => <AgentRow key={`${entry.workerId}:${entry.agentKey}`} entry={entry} onStart={onStartConversation} />)}</div>
      </section>)}
      {!groups.length && <div className="grid place-items-center rounded-xl border border-dashed border-border px-5 py-10 text-center"><div><Bot className="mx-auto size-7 text-muted-foreground" /><p className="mt-3 text-sm font-medium">暂无智能体</p><p className="mt-1 text-xs leading-5 text-muted-foreground">工作节点上线并上报 capabilities 后会显示在这里。</p></div></div>}
    </div>
  </section>
}
