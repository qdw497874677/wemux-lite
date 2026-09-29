import { useEffect, useState } from 'react'
import type { createLocalSessionApi, LocalAgentSettings, LocalConnectorList } from './local-session.ts'

type Api = ReturnType<typeof createLocalSessionApi>

export function LocalSettings({ api }: { api: Api }) {
  const [agents, setAgents] = useState<LocalAgentSettings | null>(null)
  const [connectors, setConnectors] = useState<LocalConnectorList | null>(null)
  const [paths, setPaths] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void Promise.allSettled([api.agents(), api.connectors()]).then(([agentResult, connectorResult]) => {
      if (!active) return
      if (agentResult.status === 'fulfilled') setAgents(agentResult.value)
      else setError(agentResult.reason instanceof Error ? agentResult.reason.message : 'Agent 配置不可用')
      if (connectorResult.status === 'fulfilled') setConnectors(connectorResult.value)
      else setError(current => current || (connectorResult.reason instanceof Error ? connectorResult.reason.message : '连接器配置不可用'))
    })
    return () => { active = false }
  }, [api])
  const editAgent = async (key: string, reset: boolean) => {
    if (busy) return
    setBusy(true); setError('')
    try { setAgents(reset ? await api.resetAgent(key) : await api.selectAgent(key, paths[key] ?? '')) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '修改 Agent 失败') }
    finally { setBusy(false) }
  }
  return <section className="space-y-6" aria-label="本地设置">
    <h2 className="text-xl font-medium">本地 Agent 与连接器</h2>
    <p className="text-sm text-muted-foreground">变更 Agent 可执行文件路径后，运行中的会话可能需要重启 Worker。目录授权在本地会话页单独管理。</p>
    {error && <p role="alert">{error}</p>}
    {!agents && !connectors && !error && <p role="status">正在读取本机设置…</p>}
    {agents && <div className="space-y-3"><h3 className="font-medium">Agent 配置</h3>{agents.selections.map(selection => <form key={selection.key} className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3" onSubmit={event => { event.preventDefault(); void editAgent(selection.key, false) }}><label className="min-w-56 flex-1 text-sm">{selection.key}（{selection.source}，{selection.selected ? '已显式指定' : '自动检测'}）<input className="mt-1 w-full rounded-md border border-border bg-background p-2" placeholder={selection.executable} value={paths[selection.key] ?? ''} onChange={event => setPaths(previous => ({ ...previous, [selection.key]: event.target.value }))} required /></label><button disabled={busy} className="rounded-md border border-border px-3 py-2">使用此路径</button><button disabled={busy || !selection.selected} type="button" className="rounded-md border border-border px-3 py-2" onClick={() => void editAgent(selection.key, true)}>恢复自动检测</button></form>)}</div>}
    {connectors && <div className="space-y-2"><h3 className="font-medium">本地连接器</h3><p className="text-sm text-muted-foreground">密钥后端：{connectors.credentialCapability === 'available' ? '可用' : '不可用'}。敏感凭据不会在此页面回显；新增、编辑和 Secret 管理请暂用 Worker 当前页面/API。</p>{connectors.items.map(item => <div key={item.id} className="rounded-md border border-border p-3 text-sm">{item.name}（{item.kind}），{item.enabled ? '启用' : '停用'}，凭据：{item.credentialAvailability}</div>)}{!connectors.items.length && <p className="text-sm">暂无连接器</p>}</div>}
  </section>
}
