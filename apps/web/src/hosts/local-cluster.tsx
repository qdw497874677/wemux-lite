import { useState } from 'react'
import type { createLocalSessionApi, LocalClusterDiscovery, LocalStatus } from './local-session.ts'

type Api = ReturnType<typeof createLocalSessionApi>

export function LocalCluster({ api, status, refresh }: { api: Api; status: LocalStatus; refresh: () => void }) {
  const [serverUrl, setServerUrl] = useState('')
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [discovery, setDiscovery] = useState<LocalClusterDiscovery | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [leaveConfirm, setLeaveConfirm] = useState(false)
  const [enrollAttempted, setEnrollAttempted] = useState(false)
  const phase = status.cluster?.connection?.phase ?? 'offline'
  const [pinnedServer, setPinnedServer] = useState('')
  const operate = async (operation: () => Promise<unknown>, failure: string) => {
    if (busy) return
    setBusy(true); setError('')
    try { await operation(); refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : failure); refresh() }
    finally { setBusy(false) }
  }
  return <section className="space-y-4" aria-label="集群接入">
    <h2 className="text-xl font-medium">集群接入</h2>
    <p className="text-sm text-muted-foreground">本机会话不因加入集群而上传或共享。加入后，目标 Server 可在其授权范围内调度此 Worker 使用本机 Agent 与执行资源。</p>
    <p role="status">{status.cluster?.enrolled ? `已注册：${status.cluster.serverUrl}，状态：${phase}` : '未加入集群，本地对话仍可使用。'}</p>
    {status.cluster?.connection?.failure && <p role="alert">连接异常：{status.cluster.connection.failure}</p>}
    {error && <p role="alert">{error}</p>}
    {!status.cluster?.enrolled ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); setDiscovery(null); void operate(async () => { const result = await api.discoverCluster(serverUrl.trim()); setDiscovery(result); if (!result.ok) throw new Error(result.error ?? `Server 探测失败（HTTP ${result.status}）`) }, '探测失败') }}>
      <label className="block text-sm">Server 地址<input className="mt-1 w-full rounded-md border border-border bg-background p-2" type="url" required value={serverUrl} onChange={event => { setServerUrl(event.target.value); setDiscovery(null); setPinnedServer(''); setEnrollAttempted(false) }} placeholder="https://server.example" /></label>
      <label className="block text-sm">Worker 名称<input className="mt-1 w-full rounded-md border border-border bg-background p-2" value={name} onChange={event => setName(event.target.value)} /></label>
      <button disabled={busy} className="rounded-md border border-border px-3 py-2">探测 Server</button>
    </form> : null}
    {!status.cluster?.enrolled && discovery?.ok && discovery.serverUrl === serverUrl.trim() && <form className="space-y-3" onSubmit={event => { event.preventDefault(); const destination = discovery.serverUrl; if (enrollAttempted || pinnedServer !== destination || destination !== serverUrl.trim()) return; setEnrollAttempted(true); const oneTimeToken = token; setToken(''); void operate(async () => { await api.enrollCluster(destination, oneTimeToken, name); setDiscovery(null) }, '注册结果未知，请先刷新本机状态，不要重复使用一次性口令。') }}>
      <p>探测成功：{discovery.name || discovery.serverUrl}（HTTP {discovery.status}）。探测不验证服务身份，请自行核对目标地址与证书。</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" required checked={pinnedServer === discovery.serverUrl} onChange={event => setPinnedServer(event.target.checked ? discovery.serverUrl : '')} />我已核对目标 Server 地址和证书，并同意将本机 Worker 的执行能力注册到此 Server</label>
      <label className="block text-sm">一次性注册口令<input className="mt-1 w-full rounded-md border border-border bg-background p-2" type="password" autoComplete="off" required value={token} onChange={event => setToken(event.target.value)} /></label>
      {enrollAttempted && <p role="alert">注册结果可能未知。请先刷新本机状态，核对是否已经注册，再决定是否重新申请新口令。</p>}
      <button disabled={busy || enrollAttempted} className="rounded-md bg-primary px-3 py-2 text-primary-foreground">确认加入集群</button>
    </form>}
    {status.cluster?.enrolled && <div className="space-y-3">
      <div className="flex flex-wrap gap-2"><button disabled={busy || phase === 'online' || phase === 'connecting'} className="rounded-md border border-border px-3 py-2" onClick={() => void operate(() => api.resumeCluster(), '重连失败')}>重连</button><button disabled={busy || phase === 'offline'} className="rounded-md border border-border px-3 py-2" onClick={() => void operate(() => api.pauseCluster(), '暂停失败')}>暂停连接</button><button disabled={busy} className="rounded-md border border-border px-3 py-2" onClick={() => setLeaveConfirm(true)}>退出集群</button></div>
      {leaveConfirm && <div role="alert" className="space-y-2 rounded-md border border-border p-3"><p>退出将解除本机保存的连接身份，但不会删除本地会话。若 Server 离线，远端记录仍须由管理员清理。进行中的集群任务可能受影响，确认后继续。</p><div className="flex gap-2"><button disabled={busy} onClick={() => { setLeaveConfirm(false); void operate(() => api.leaveCluster(), '退出失败') }} className="rounded-md border border-border px-3 py-2">确认退出</button><button onClick={() => setLeaveConfirm(false)} className="rounded-md border border-border px-3 py-2">取消</button></div></div>}
    </div>}
  </section>
}
