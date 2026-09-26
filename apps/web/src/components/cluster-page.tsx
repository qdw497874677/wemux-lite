import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useResources } from '../app/resources'
// 集群阶段管理：参照 wemux-slim 的 admin-nodes-page（节点/心跳）与 admin-tasks-page（阶段统计+表格+动作），
// 映射到 wemux-lite 的三条阶段线：命令交付（pending→accepted/rejected/failed/cancelled）、
// 工作区供给（pending→provisioning→ready/failed）、会话运行（idle/queued/running/…）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Ban, Bot, Clock, RefreshCw, Server, ServerCog, TriangleAlert, UploadCloud } from 'lucide-react'
import type { ApiError } from '../api/client'
import type { Api } from '../api/client'
import type { CommandDTO, CommandStatus, ProjectDTO, SessionDTO, WorkerDTO, WorkspaceDTO } from '../api/dto'
import { Badge } from './ui/badge'
import { commandStateLabel, formatChineseTime, runtimeStateLabel, workerStateLabel, workspaceStateLabel } from '@/lib/display'
import { Button } from './ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { cn } from '../lib/utils'
import { WorkerAccessPanel } from './worker-access.tsx'

const heartbeatFreshMs = 120_000

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : '请求失败'

const formatAge = (iso: string | null) => {
  if (!iso) return null
  const age = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(age) || age < 1000) return '刚刚'
  if (age < 60_000) return `${Math.round(age / 1000)} 秒`
  if (age < 3_600_000) return `${Math.round(age / 60_000)} 分钟`
  if (age < 86_400_000) return `${Math.round(age / 3_600_000)} 小时`
  return `${Math.round(age / 86_400_000)} 天`
}

const shortId = (value: string) => value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value

const commandTone = (status: CommandStatus) =>
  status === 'accepted' || status === 'completed' ? 'success'
    : status === 'rejected' || status === 'failed' ? 'danger'
      : status === 'cancelled' ? 'outline'
        : 'warning'

const workspaceTone: Record<WorkspaceDTO['status'], 'success' | 'warning' | 'danger' | 'outline' | 'default'> = {
  ready: 'success', stopped: 'outline', deleted: 'outline', failed: 'danger', unhealthy: 'warning',
}

const runtimeTone = (state: SessionDTO['runtimeState']) =>
  state === 'running' ? 'success' : state === 'failed' || state === 'unavailable' ? 'danger'
    : state === 'queued' || state === 'stopping' ? 'warning' : 'outline'

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'success' | 'warning' | 'danger' }) {
  return <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
    <p className="truncate text-[11px] text-muted-foreground">{label}</p>
    <p className={cn('mt-1 text-xl font-semibold sm:text-2xl', tone === 'success' && 'text-emerald-400', tone === 'warning' && 'text-amber-300', tone === 'danger' && 'text-red-400')}>{value}</p>
    {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
  </div>
}

function StageTable({ headers, rows, empty }: { headers: string[]; rows: React.ReactNode[][]; empty: string }) {
  return <div className="overflow-x-auto" tabIndex={0} aria-label="可横向滚动的数据表格">
    <table className="w-full min-w-[680px] text-left text-xs">
      <thead>
        <tr className="border-b border-border text-[11px] text-muted-foreground">{headers.map(header => <th key={header} className="px-3 py-2 font-medium">{header}</th>)}</tr>
      </thead>
      <tbody>
        {rows.length ? rows.map((row, index) => <tr key={index} className="border-b border-border/50 last:border-0">{row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2.5 align-middle">{cell}</td>)}</tr>)
          : <tr><td colSpan={headers.length} className="px-3 py-8 text-center text-muted-foreground">{empty}</td></tr>}
      </tbody>
    </table>
  </div>
}

export function ClusterPage({ api, connected, canEnrollWorkers, onAddWorker, onRefresh }: { api: Api; connected: boolean; canEnrollWorkers: boolean; onAddWorker: () => void; onRefresh: () => void }) {
  const resources = useResources(api, true)
  const client = useQueryClient()
  const workers = resources.workers.data ?? []
  const projects = resources.projects.data ?? []
  const workspaces = resources.workspaces.data ?? []
  const sessions = resources.sessions.data ?? []
  const commandQuery = useQuery({ queryKey: ['commands'], queryFn: ({ signal }) => api.commands(signal), refetchInterval: 5000, enabled: connected && canEnrollWorkers })
  const commands = commandQuery.data ?? []
  const [actionError, setError] = useState('')
  const error = actionError || (commandQuery.error ? `命令数据可能过期：${errorText(commandQuery.error)}` : '')
  const [busy, setBusy] = useState('')
  const loadedAt = commandQuery.dataUpdatedAt ? formatChineseTime(commandQuery.dataUpdatedAt) : ''
  const load = async (_signal: AbortSignal) => { await client.invalidateQueries() }

  const workerName = useMemo(() => new Map(workers.map(worker => [worker.id, worker.name])), [workers])
  const projectName = useMemo(() => new Map(projects.map(project => [project.id, project.name])), [projects])
  const sessionCountByWorker = useMemo(() => {
    const counts = new Map<string, number>()
    for (const session of sessions) counts.set(session.workerId, (counts.get(session.workerId) ?? 0) + 1)
    return counts
  }, [sessions])
  const workspaceCountByWorker = useMemo(() => {
    const counts = new Map<string, number>()
    for (const workspace of workspaces) for (const placement of workspace.placements) counts.set(placement.workerId, (counts.get(placement.workerId) ?? 0) + 1)
    return counts
  }, [workspaces])

  const stats = {
    workersOnline: workers.filter(worker => worker.connectionState === 'online').length,
    workersTotal: workers.length,
    workspacesReady: workspaces.filter(workspace => workspace.status === 'ready').length,
    workspacesStopped: workspaces.filter(workspace => workspace.status === 'stopped').length,
    workspacesFailed: workspaces.filter(workspace => workspace.status === 'failed' || workspace.status === 'unhealthy').length,
    sessionsRunning: sessions.filter(session => session.runtimeState === 'running').length,
    sessionsTotal: sessions.length,
    commandsPending: commands.filter(command => command.status === 'pending').length,
    commandsFailed: commands.filter(command => command.status === 'rejected' || command.status === 'failed').length,
  }

  async function act(key: string, action: () => Promise<unknown>) {
    if (busy) return
    setBusy(key); setError('')
    try { await action(); await load(new AbortController().signal) }
    catch (cause) { setError(errorText(cause)) }
    finally { setBusy('') }
  }

  return <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto max-w-[1500px] space-y-5 px-3 py-4 sm:px-5 sm:py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold">集群运行状态</h1>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">工作节点连接 · 命令交付 · 工作区初始化 · 会话运行{loadedAt ? ` · 更新于 ${loadedAt}` : ''}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => { onRefresh() }}><RefreshCw className="size-4" />刷新</Button>
          {canEnrollWorkers && <Button variant="outline" size="sm" disabled={!connected} onClick={onAddWorker}><ServerCog className="size-4" />添加工作节点</Button>}
        </div>
      </header>

      {!connected && <p className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-100">连接服务端后才能查看和管理集群。</p>}
      {error && <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}

      <section className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
        <Stat label="工作节点在线" value={`${stats.workersOnline} / ${stats.workersTotal}`} tone={stats.workersTotal === 0 ? 'warning' : stats.workersOnline === stats.workersTotal ? 'success' : 'warning'} hint="心跳 2 分钟内视为在线" />
        <Stat label="工作区" value={`${stats.workspacesReady} 运行中`} tone={stats.workspacesFailed > 0 ? 'danger' : stats.workspacesStopped > 0 ? 'warning' : 'success'} hint={`${stats.workspacesStopped} 已停止 · ${stats.workspacesFailed} 异常`} />
        <Stat label="会话运行" value={`${stats.sessionsRunning} / ${stats.sessionsTotal}`} tone={stats.sessionsRunning > 0 ? 'success' : undefined} hint="运行中 / 全部会话" />
        <Stat label="待交付命令" value={String(stats.commandsPending)} tone={stats.commandsFailed > 0 ? 'danger' : stats.commandsPending > 0 ? 'warning' : 'success'} hint={`${stats.commandsFailed} 失败/拒绝`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">工作节点</h2>
        {!workers.length && <p className="rounded-xl border border-border bg-card p-6 text-center text-xs text-muted-foreground">{canEnrollWorkers ? '尚未注册任何工作节点。点击「添加工作节点」生成注册命令。' : '当前账号没有可使用的工作节点。请联系节点 owner 或 manager 授予 use 权限。'}</p>}
        <div className="grid gap-3 md:grid-cols-2">
          {workers.map(worker => {
            const heartbeatAge = formatAge(worker.lastSeenAt)
            const fresh = worker.connectionState === 'online' && heartbeatAge !== null && (Date.now() - new Date(worker.lastSeenAt!).getTime()) <= heartbeatFreshMs
            const executionAgents = worker.capabilities.filter(agent => agent.mode === 'execution' && agent.availability.status === 'available')
            return <article key={worker.id} className={cn('rounded-xl border border-border bg-card p-4', worker.connectionState === 'revoked' && 'opacity-70')}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', worker.connectionState === 'online' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-muted text-muted-foreground')}><Server className="size-4" /></span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <strong className="truncate text-xs">{worker.name}</strong>
                      <Badge variant={worker.connectionState === 'online' ? 'success' : worker.connectionState === 'revoked' ? 'danger' : 'warning'}>{workerStateLabel[worker.connectionState]}</Badge>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{shortId(worker.id)}</p>
                  </div>
                </div>
                {(worker.accessRole === 'owner' || worker.accessRole === 'manage') && worker.connectionState !== 'revoked' && <Button variant="ghost" size="sm" className="h-7 text-[11px] text-red-400 hover:text-red-300" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`撤销 Worker「${worker.name}」？撤销后将断开连接，无法再用当前凭据接入。`)) void act(`revoke:${worker.id}`, () => api.revokeWorker(worker.id)) }}><Ban className="size-3.5" />撤销</Button>}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                <div className="rounded-md bg-muted/40 px-2.5 py-1.5"><p className="text-muted-foreground">心跳</p><p className={cn('mt-0.5 font-medium', fresh ? 'text-emerald-400' : 'text-amber-300')}>{worker.connectionState === 'online' ? heartbeatAge ?? '未知' : '离线'}</p></div>
                <div className="rounded-md bg-muted/40 px-2.5 py-1.5"><p className="text-muted-foreground">可用智能体</p><p className="mt-0.5 font-medium">{executionAgents.length} / {worker.capabilities.length}</p></div>
                <div className="rounded-md bg-muted/40 px-2.5 py-1.5"><p className="text-muted-foreground">会话</p><p className="mt-0.5 font-medium">{sessionCountByWorker.get(worker.id) ?? 0}</p></div>
                <div className="rounded-md bg-muted/40 px-2.5 py-1.5"><p className="text-muted-foreground">工作区</p><p className="mt-0.5 font-medium">{workspaceCountByWorker.get(worker.id) ?? 0}</p></div>
              </div>
              <p className="mt-2 truncate text-[10px] text-muted-foreground"><Clock className="mr-1 inline size-3" />{worker.version ? `v${worker.version}` : '版本未知'}{worker.platform ? ` · ${worker.platform}` : ''} · 最后在线 {worker.lastSeenAt ? formatChineseTime(worker.lastSeenAt) : '从未'} · 权限 {worker.accessRole}</p>
              <WorkerAccessPanel api={api} worker={worker} onChanged={() => void client.invalidateQueries({ queryKey: ['workers'] })} />
            </article>
          })}
        </div>
      </section>

      <Tabs defaultValue={canEnrollWorkers ? 'commands' : 'workspaces'} variant="plain" className="space-y-3">
        <TabsList className="w-full justify-start overflow-x-auto">
          {canEnrollWorkers && <TabsTrigger value="commands">命令交付（{commands.length}）</TabsTrigger>}
          <TabsTrigger value="workspaces">工作区落点（{workspaces.reduce((sum, workspace) => sum + workspace.placements.length, 0)}）</TabsTrigger>
          <TabsTrigger value="sessions">会话运行（{sessions.length}）</TabsTrigger>
        </TabsList>

        {canEnrollWorkers && <TabsContent value="commands" className="rounded-xl border border-border bg-card">
          <StageTable
            headers={['命令', '工作节点', '状态', '创建于', '操作']}
            empty="命令列表为空。发送消息、创建工作区或会话后，命令先进入 pending，经工作节点确认后推进。"
            rows={commands.map(command => [
              <span key="id" className="font-mono text-[10px]" title={command.commandId}>{shortId(command.commandId)}</span>,
              <span key="worker">{workerName.get(command.workerId) ?? shortId(command.workerId)}</span>,
              <Badge key="status" variant={commandTone(command.status)}>{commandStateLabel[command.status]}</Badge>,
              <span key="age" className="text-muted-foreground">{formatAge(command.createdAt) ?? '未知'} 前</span>,
              command.status === 'pending'
                ? <Button key="cancel" variant="ghost" size="sm" className="h-7 text-[11px] text-red-400 hover:text-red-300" disabled={busy === `cancel:${command.commandId}`} onClick={() => { if (window.confirm('取消该命令？仅尚未交付给工作节点的“等待下发”命令可取消。')) void act(`cancel:${command.commandId}`, () => api.cancelCommand(command.commandId)) }}><Ban className="size-3.5" />取消</Button>
                : <span key="none" className="text-muted-foreground">—</span>,
            ])}
          />
        </TabsContent>}

        <TabsContent value="workspaces" className="rounded-xl border border-border bg-card">
          <StageTable
            headers={['工作区', '项目', '工作节点', '状态', '失败原因', '操作']}
            empty="暂无工作区落点。在工作台创建工作区并选择工作节点后会建立 Placement。"
            rows={workspaces.flatMap(workspace => workspace.placements.map(placement => [
              <strong key="name" className="text-xs">{workspace.name}</strong>,
              <span key="project">{projectName.get(workspace.projectId) ?? shortId(workspace.projectId)}</span>,
              <span key="worker">{workerName.get(placement.workerId) ?? shortId(placement.workerId)}</span>,
              <Badge key="status" variant={workspaceTone[placement.status]}>{workspaceStateLabel[placement.status]}</Badge>,
              placement.failureReason ? <span key="reason" className="max-w-48 truncate text-red-300" title={placement.failureReason}>{placement.failureReason}</span> : <span key="reason" className="text-muted-foreground">—</span>,
              placement.status === 'stopped' || placement.status === 'failed'
                ? <Button key="retry" variant="ghost" size="sm" className="h-7 text-[11px]" disabled={busy === `retry:${workspace.id}:${placement.workerId}`} onClick={() => void act(`retry:${workspace.id}:${placement.workerId}`, () => api.reprovisionWorkspace(workspace.id, placement.workerId))}><UploadCloud className="size-3.5" />重新下发</Button>
                : <span key="none" className="text-muted-foreground">—</span>,
            ]))}
          />
        </TabsContent>

        <TabsContent value="sessions" className="rounded-xl border border-border bg-card">
          <StageTable
            headers={['会话', '项目', '工作节点', '智能体 / 模型', '运行状态', '操作']}
            empty="暂无会话。创建会话后，可在这里查看运行状态和所属工作节点。"
            rows={sessions.map(session => [
              <span key="title" className="flex items-center gap-2"><Bot className="size-3.5 text-violet-300" /><strong className="text-xs">{session.title}</strong></span>,
              <span key="project">{projectName.get(session.projectId ?? '') ?? '—'}</span>,
              <span key="worker">{workerName.get(session.workerId) ?? shortId(session.workerId)}</span>,
              <span key="agent" className="text-muted-foreground">{session.agentKey} / {session.modelId}</span>,
              <Badge key="state" variant={runtimeTone(session.runtimeState)}>{runtimeStateLabel[session.runtimeState]}</Badge>,
              <Button key="delete" variant="ghost" size="sm" className="h-7 text-[11px] text-red-400 hover:text-red-300" disabled={busy === `delete:${session.id}`} onClick={() => { if (window.confirm(`删除会话「${session.title}」？该操作不可恢复。`)) void act(`delete:${session.id}`, () => api.deleteSession(session.id)) }}><TriangleAlert className="size-3.5" />删除</Button>,
            ])}
          />
        </TabsContent>
      </Tabs>
    </div>
  </div>
}
