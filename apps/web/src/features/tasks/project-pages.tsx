import type { useProject } from '../../app/use-project'
import { useBrowserOnline } from '../../app/layers'

type Data = ReturnType<typeof useProject>
const base = (id: string) => `/projects/${encodeURIComponent(id)}`
const taskLink = (p: string, t: string, run?: string) => `${base(p)}/tasks/${encodeURIComponent(t)}${run ? `?tab=runs&run=${encodeURIComponent(run)}` : ''}`
export function ProjectOverview({ projectId, data }: { projectId: string; data: Data }) {
  const { tasks, reviews, workspaces } = data
  const online = useBrowserOnline()
  return <div className="space-y-5">
    {!online && <p role="alert">浏览器离线；概览为缓存，恢复连接后核对。</p>}
    {[tasks, reviews, workspaces].some(q => q.isPending) && <p role="status">正在读取项目概览…</p>}
    {[tasks, reviews, workspaces].map((q, i) => q.error && <p role="alert" key={i}>{q.error.message}</p>)}
    <details className="border-t border-border pt-4" open={Boolean(tasks.data?.some(t => t.activeRun) || reviews.data?.length || workspaces.data?.some(w => w.status === 'failed'))}><summary className="cursor-pointer text-sm font-medium">任务与运行动态</summary><div className="mt-4 grid gap-4 text-sm text-muted-foreground sm:grid-cols-3">
    <section><h2 className="mb-2 font-medium text-foreground">活跃执行</h2>{tasks.data?.filter(t => t.activeRun).map(t => <a className="block border-b py-3 underline" key={t.id} href={taskLink(projectId, t.id, t.activeRun!.id)}>{t.title} · {t.activeRun!.status}</a>)}{tasks.isSuccess && !tasks.data.some(t => t.activeRun) && <p>暂无活跃 Run。</p>}</section>
    <section><h2 className="mb-2 font-medium text-foreground">待审查任务</h2>{reviews.data?.map(r => <a className="block border-b py-3 underline" key={r.id} href={taskLink(projectId, r.taskId, r.taskRunId)}>{tasks.data?.find(t => t.id === r.taskId)?.title ?? r.taskId} · {r.requestedAt}</a>)}{reviews.isSuccess && !reviews.data.length && <p>暂无待审查请求。</p>}</section>
    <section><h2 className="mb-2 font-medium text-foreground">准备失败的工作区</h2>{workspaces.data?.filter(w => w.status === 'failed').map(w => <a className="block border-b py-3 underline" key={w.id} href={(() => { const activity = data.activity.data?.slice().reverse().find(item => item.activity.payload.workspaceId === w.id)?.activity; return activity ? `${taskLink(projectId, activity.taskId)}?tab=workspaces` : `${base(projectId)}/workspaces/${encodeURIComponent(w.id)}` })()}>{w.name} · {w.failureReason}</a>)}{workspaces.isSuccess && !workspaces.data.some(w => w.status === 'failed') && <p>暂无准备失败的工作区。</p>}</section>
    </div></details>
    <a className="inline-flex min-h-11 items-center text-xs text-muted-foreground underline underline-offset-4" href={`${base(projectId)}/activity`}>通知与项目活动</a>
  </div>
}
export function ProjectActivity({ projectId, data }: { projectId: string; data: Data }) {
  return <section className="space-y-3"><h1>项目活动</h1><p role="status">项目实时通知：{data.stream} · 每 10 秒核对持久历史</p>
    {data.activity.isPending && <p>正在读取活动…</p>}{data.activity.error && <p role="alert">{data.activity.error.message} · 已有历史保留，恢复连接后继续补传。</p>}
    {data.activity.isSuccess && !data.activity.data.length && <p>暂无项目活动。</p>}
    <ol>{data.activity.data?.map(({ cursor, activity: a }) => <li key={`${a.taskId}:${a.seq}`} className="border-b py-3 break-words"><a className="underline" href={taskLink(projectId, a.taskId, typeof a.payload.runId === 'string' ? a.payload.runId : typeof a.payload.taskRunId === 'string' ? a.payload.taskRunId : undefined)}>#{cursor} · {a.type}</a><p className="text-xs text-muted-foreground">{a.actor} · {a.occurredAt}</p><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(a.payload)}</pre></li>)}</ol>
  </section>
}
