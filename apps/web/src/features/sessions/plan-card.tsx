import { useState } from 'react'
import { Check, ChevronDown, ChevronUp, ListChecks, Pencil } from 'lucide-react'

import type { ProposedPlan } from '../../api/journal.ts'
import { Response } from '../../components/ai-elements/response.tsx'
import { Badge } from '../../components/ui/badge.tsx'
import { Button } from '../../components/ui/button.tsx'
import { cn } from '../../lib/utils.ts'

const statusLabels: Record<ProposedPlan['status'], string> = {
  pending: '待确认',
  approved: '已批准',
  modified: '已修改',
}

export function ProposedPlanCard({ plan, canAct, onApprove, onModify }: { plan: ProposedPlan; canAct: boolean; onApprove: () => void; onModify: () => void }) {
  const [collapsed, setCollapsed] = useState(false)
  const pending = plan.status === 'pending'
  return <article className={cn('overflow-hidden rounded-2xl border border-border/80 border-l-4 bg-card/75 shadow-sm', pending ? 'border-l-primary' : 'border-l-muted-foreground/35')} aria-label="执行计划">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2.5"><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><ListChecks className="size-4" /></span><div><h3 className="text-sm font-semibold text-foreground">执行计划</h3><p className="text-xs text-muted-foreground">{plan.steps?.length ? `${plan.steps.length} 个步骤` : 'Markdown 计划'}</p></div><Badge variant={pending ? 'secondary' : 'outline'}>{statusLabels[plan.status]}</Badge></div>
      <Button type="button" size="sm" variant="ghost" onClick={() => setCollapsed(value => !value)} aria-expanded={!collapsed}>{collapsed ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}{collapsed ? '展开' : '折叠'}</Button>
    </header>
    {!collapsed && <div className="p-4">
      {plan.steps?.length ? <ol className="space-y-2.5">{plan.steps.map((step, index) => <li key={`${index}:${step}`} className="group flex gap-3 rounded-xl border border-transparent px-2.5 py-2 transition-colors hover:border-border/70 hover:bg-accent/45"><span className="grid size-6 shrink-0 place-items-center rounded-full border border-primary/30 bg-primary/10 text-xs font-semibold text-primary">{index + 1}</span><p className="min-w-0 pt-0.5 text-sm leading-6 text-foreground/90">{step}</p></li>)}</ol> : <div className="rounded-xl bg-muted/35 px-3.5 py-3 text-sm"><Response>{plan.text}</Response></div>}
      {pending && <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border/60 pt-3"><Button type="button" size="sm" variant="outline" disabled={!canAct} onClick={onModify}><Pencil className="size-4" />修改</Button><Button type="button" size="sm" disabled={!canAct} onClick={onApprove}><Check className="size-4" />批准</Button></div>}
    </div>}
  </article>
}
