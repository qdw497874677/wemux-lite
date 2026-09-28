import type { AttentionGroup, AttentionView } from '@wemux/server-domain'
import { AlertTriangle, CheckCheck, CircleDotDashed, Inbox, ListTodo, RefreshCw } from 'lucide-react'
import type { Api } from '../../api/client.ts'
import { useAttention } from './use-attention.ts'

const icons = { approval: CheckCheck, task_assignment: ListTodo, run_problem: CircleDotDashed, channel_dead_letter: AlertTriangle }

export function AttentionPage({ api }: { readonly api: Api }) {
  const query = useAttention(api)
  return <main className="content-shell" data-testid="attention-page">
    <header className="content-header">
      <div><p className="eyebrow">WhatNeedsMe</p><h1>待办</h1><p>汇总需要你处理的审批、任务、运行问题与管理员投递告警。</p></div>
      <button className="secondary-button" type="button" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw size={15} />刷新</button>
    </header>
    {query.isLoading ? <div className="empty-card"><RefreshCw size={20} className="spin" />正在整理待办</div> : null}
    {query.isError ? <div className="empty-card"><AlertTriangle size={20} /><strong>待办加载失败</strong><span>{query.error instanceof Error ? query.error.message : '请稍后重试'}</span></div> : null}
    {query.data?.total === 0 ? <div className="empty-card" data-testid="attention-empty"><Inbox size={28} /><strong>现在没有需要你处理的事项</strong><span>新的审批、指派或运行异常会出现在这里。</span></div> : null}
    {query.data && query.data.total > 0 ? <section className="attention-groups">{query.data.groups.filter(group => group.count > 0).map(group => <AttentionGroupCard key={group.kind} group={group} />)}</section> : null}
  </main>
}

function AttentionGroupCard({ group }: { readonly group: AttentionGroup }) {
  const Icon = icons[group.kind]
  return <article className="attention-group" data-testid={`attention-group-${group.kind}`}>
    <header><div className="attention-group__title"><Icon size={18} /><h2>{group.label}</h2></div><span className="count-badge">{group.count}</span></header>
    <div className="attention-items">{group.items.map(item => <AttentionItemLink key={item.projectionKey} item={item} />)}</div>
  </article>
}

function AttentionItemLink({ item }: { readonly item: AttentionView }) {
  return <a className="attention-item" href={item.href}>
    <span><strong>{item.title}</strong>{item.detail ? <small>{item.detail}</small> : null}</span>
    <time>{new Date(item.occurredAt ?? item.freshness.observedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
  </a>
}
