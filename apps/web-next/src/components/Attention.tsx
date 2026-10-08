import type { ProjectClient } from './ProjectManagement.tsx'
import type { ProjectDTO } from '@wemux/web-contract/browser-host'
import { useEffect, useRef, useState } from 'react'
import { navigate } from '../lib/navigation.ts'
import { Button } from './primitives.tsx'

type AttentionPage = Awaited<ReturnType<ProjectClient['attentionPages']>>
type AttentionKind = Parameters<ProjectClient['attentionPages']>[0]['kind']
const groups: readonly { kind: AttentionKind; label: string }[] = [
  { kind: 'approval', label: '任务人工审查' },
  { kind: 'run_problem', label: '执行异常' },
  { kind: 'channel_dead_letter', label: '渠道投递失败' },
]

/** Read-only, bounded attention pages. Project membership is checked again in this view. */
export function Attention({ api, projects, busy, administrator }: { api: ProjectClient; projects: readonly ProjectDTO[]; busy: boolean; administrator: boolean }) {
  const [revision, setRevision] = useState(0)
  // App clears projects while revalidating permissions. Keep the confirmed scope
  // so hidden groups retain their pages until the new grants are authoritative.
  const confirmed = useRef(projects)
  if (!busy) confirmed.current = projects
  const display = busy ? confirmed.current : projects
  const projectIds = JSON.stringify(display.map(project => project.id).sort())
  const projectScope = JSON.stringify([...display].sort((a, b) => a.id.localeCompare(b.id)).map(project => [project.id, project.accessRole]))
  return <section className="account-section"><h1>待办</h1>
    <Button variant="outline" disabled={busy} onClick={() => setRevision(value => value + 1)}>刷新待办</Button>
    <p>此页分页展示可处理的任务人工审查、执行异常和渠道投递失败。会话工具审批未在此页加载；任务指派尚无人工指派模型，暂不支持，不代表没有其他待办。渠道投递失败仅实例管理员可见。</p>
    {busy && <p role="status">正在核验项目权限…</p>}
    <div hidden={busy} inert={busy}>{administrator
      ? groups.map(group => <AttentionGroup key={`${revision}:${projectScope}:${group.kind}`} api={api} projectIds={projectIds} busy={busy} {...group} />)
      : groups.filter(group => group.kind !== 'channel_dead_letter').map(group => <AttentionGroup key={`${revision}:${projectScope}:${group.kind}`} api={api} projectIds={projectIds} busy={busy} {...group} />)}
      <section aria-label="渠道投递失败"><h2>渠道投递失败（不可见）</h2><p>渠道死信仅实例管理员可处理，当前账号不是实例管理员。</p></section>
    </div>
  </section>
}

type GroupState = { api: ProjectClient; projectIds: string; kind: AttentionKind; items: AttentionPage['items']; nextCursor: string | null; loading: boolean; loaded: boolean; error: string }

function AttentionGroup({ api, projectIds, busy, kind, label }: { api: ProjectClient; projectIds: string; busy: boolean; kind: AttentionKind; label: string }) {
  const [state, setState] = useState<GroupState>()
  const pages = useRef<GroupState>(undefined)
  const load = useRef<() => void>(() => {})
  useEffect(() => {
    if (pages.current?.api !== api || pages.current.projectIds !== projectIds || pages.current.kind !== kind) {
      pages.current = { api, projectIds, kind, items: [], nextCursor: null, loading: false, loaded: false, error: '' }
    }
    // Permission rechecks suspend requests, not confirmed pages. Scope changes and
    // the parent's authorization failure unmount retire those pages instead.
    const saved = pages.current
    saved.loading = false
    if (busy) return
    const allowed = new Set<string>(JSON.parse(projectIds))
    const controller = new AbortController()
    let { items, nextCursor, loaded } = saved
    let loading = false
    const publish = (error = '') => {
      Object.assign(saved, { items, nextCursor, loading, loaded, error })
      setState({ ...saved })
    }
    const loadPage = async () => {
      // The synchronous lock also covers multiple clicks before React renders disabled controls.
      if (controller.signal.aborted || loading || (loaded && nextCursor === null)) return
      loading = true
      publish()
      try {
        const page = await api.attentionPages({ kind, limit: 50, ...(nextCursor === null ? {} : { cursor: nextCursor }) }, controller.signal)
        if (controller.signal.aborted) return
        const seen = new Set(items.map(item => item.projectionKey))
        items = [...items, ...page.items.filter(item => {
          if (!allowed.has(item.projectId) || seen.has(item.projectionKey)) return false
          seen.add(item.projectionKey)
          return true
        })]
        nextCursor = page.nextCursor
        loaded = true
        loading = false
        publish()
      } catch (error) {
        if (controller.signal.aborted) return
        loading = false
        publish(error instanceof Error ? error.message : '加载失败，请重试。')
      }
    }
    load.current = () => { void loadPage() }
    if (!allowed.size) { loaded = true; publish() }
    else if (!loaded && !saved.error) load.current()
    else publish(saved.error)
    return () => { controller.abort(); load.current = () => {} }
  }, [api, projectIds, kind, busy])
  // An old account's results must not appear even during the render before effect cleanup.
  const current = state?.api === api ? state : undefined
  const items = current?.items ?? []
  return <section aria-label={label}><h2>{label}（已加载 {items.length} 项）</h2>
    {items.length > 0 && <ul>{items.map(item => <li className="account-row" key={item.projectionKey}><a href={item.href} onClick={event => { if (item.href.startsWith('/next/') && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(item.href) } }}>{item.title}</a><span>{item.detail}</span></li>)}</ul>}
    {(!current || current.loading) && <p role="status">正在加载{label}…</p>}
    {current?.error && <p role="alert">{current.error}</p>}
    {current?.loaded && !current.loading && !current.error && !items.length && <p>{current.nextCursor ? '本页没有当前可见项目的待办，可继续加载。' : '已加载范围内暂无待办。'}</p>}
    {current && (current.error || current.nextCursor) && <Button variant="outline" disabled={current.loading} onClick={() => load.current()}>{current.error ? `重试${label}` : `加载更多${label}`}</Button>}
  </section>
}
