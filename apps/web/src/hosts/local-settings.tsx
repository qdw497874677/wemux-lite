import { useEffect, useState } from 'react'
import type { createLocalSessionApi, LocalAgentInstallation, LocalAgentSettings, LocalConnectorDefinition, LocalConnectorList } from './local-session.ts'
import { LocalConnectorEditor } from './local-connector-editor.tsx'

type Api = ReturnType<typeof createLocalSessionApi>

export function LocalSettings({ api }: { api: Api }) {
  const [agents, setAgents] = useState<LocalAgentSettings | null>(null)
  const [connectors, setConnectors] = useState<LocalConnectorList | null>(null)
  const [paths, setPaths] = useState<Record<string, string>>({})
  const [installation, setInstallation] = useState<LocalAgentInstallation['installation']>(null)
  const [installConfirmation, setInstallConfirmation] = useState('')
  const [editing, setEditing] = useState<LocalConnectorDefinition | 'new' | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [credential, setCredential] = useState<LocalConnectorDefinition | null>(null)
  const [secret, setSecret] = useState('')
  const [credentialId, setCredentialId] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const refreshConnectors = async () => { setConnectors(await api.connectors()) }
  useEffect(() => {
    let active = true
    void Promise.allSettled([api.agents(), api.connectors(), api.agentInstallation()]).then(([agentResult, connectorResult, installResult]) => {
      if (!active) return
      if (agentResult.status === 'fulfilled') setAgents(agentResult.value)
      else setError(agentResult.reason instanceof Error ? agentResult.reason.message : 'Agent 配置不可用')
      if (connectorResult.status === 'fulfilled') setConnectors(connectorResult.value)
      else setError(current => current || (connectorResult.reason instanceof Error ? connectorResult.reason.message : '连接器配置不可用'))
      if (installResult.status === 'fulfilled') setInstallation(installResult.value.installation)
    })
    return () => { active = false }
  }, [api])
  useEffect(() => {
    if (installation?.phase !== 'installing') return
    let active = true
    const timer = window.setInterval(() => { void api.agentInstallation().then(result => { if (active) setInstallation(result.installation) }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '安装状态不可用') }) }, 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [api, installation?.phase])
  const editAgent = async (key: string, reset: boolean) => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { setAgents(reset ? await api.resetAgent(key) : await api.selectAgent(key, paths[key] ?? '')) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '修改 Agent 失败') }
    finally { setBusy(false) }
  }
  const install = async (key: string) => {
    if (busy) return
    setInstallConfirmation(''); setBusy(true); setError('')
    try { setInstallation((await api.installAgent(key)).installation) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '安装启动失败') }
    finally { setBusy(false) }
  }
  const remove = async (id: string) => {
    setRemoving(null); setBusy(true); setError('')
    try { await api.deleteConnector(id); await refreshConnectors(); setNotice('连接器已删除') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '删除连接器失败') }
    finally { setBusy(false) }
  }
  const storeSecret = async () => {
    if (!credential || busy) return
    const target = credential
    const fields = target.config.transport === 'stdio' ? target.config.secretEnvironmentNames : ['value']
    if (fields.length !== 1 || !secret || credentialId !== target.credentialRef) { setError('请先设置匹配此连接器的凭据标识，并输入单字段 Secret'); return }
    const value = secret
    setSecret(''); setBusy(true); setError(''); setNotice('')
    try { await api.putConnectorCredential(target.id, credentialId, { [fields[0]]: value }, 'custom_credential'); setCredential(null); setCredentialId(''); await refreshConnectors(); setNotice('凭据已加密保存，值不在页面回显') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '写入凭据失败，请重新输入；密钥不会重试或回显') }
    finally { setBusy(false) }
  }
  return <section className="space-y-6" aria-label="本地设置">
    <h2 className="text-xl font-medium">本地 Agent 与连接器</h2>
    <p className="text-sm text-muted-foreground">变更 Agent 可执行文件路径后，运行中的会话可能需要重启 Worker。目录授权在本地会话页单独管理。</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!agents && !connectors && !error && <p role="status">正在读取本机设置…</p>}
    {agents && <div className="space-y-3"><h3 className="font-medium">Agent 配置</h3>{agents.selections.map(selection => <form key={selection.key} className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3" onSubmit={event => { event.preventDefault(); void editAgent(selection.key, false) }}><label className="min-w-56 flex-1 text-sm">{selection.key}（{selection.source}，{selection.selected ? '已显式指定' : '自动检测'}）<input className="mt-1 w-full rounded-md border border-border bg-background p-2" placeholder={selection.executable} value={paths[selection.key] ?? ''} onChange={event => setPaths(previous => ({ ...previous, [selection.key]: event.target.value }))} required /></label><button disabled={busy} className="rounded-md border border-border px-3 py-2">使用此路径</button><button disabled={busy || !selection.selected} type="button" className="rounded-md border border-border px-3 py-2" onClick={() => void editAgent(selection.key, true)}>恢复自动检测</button>{['pi', 'claude-code', 'opencode'].includes(selection.key) && <button type="button" disabled={busy || installation?.phase === 'installing'} className="rounded-md border border-border px-3 py-2" onClick={() => setInstallConfirmation(selection.key)}>托管安装</button>}</form>)}
      {installConfirmation && <div role="alert" className="space-y-2 rounded-md border border-border p-3"><p>将为 {installConfirmation} 下载并校验固定版本官方 npm 包，安装过程可能运行上游脚本；需网络及信任上游。只安装在 Worker home 中，完成后需重启 Worker，旧选择在安装失败时保留。</p><button disabled={busy} onClick={() => void install(installConfirmation)} className="rounded-md border border-border px-3 py-2">确认联网安装</button><button onClick={() => setInstallConfirmation('')} className="rounded-md border border-border px-3 py-2">取消</button></div>}
      {installation && <p role="status">{installation.key}：{installation.phase === 'installing' ? '安装中' : installation.phase === 'ready' ? '安装完成' : '安装失败'}。{installation.message}</p>}
    </div>}
    {connectors && <div className="space-y-2"><h3 className="font-medium">本地连接器</h3><p className="text-sm text-muted-foreground">密钥后端：{connectors.credentialCapability === 'available' ? '可用' : '不可用'}。仅允许管理本机创建的 MCP 连接器；本机凭据只写入加密后端，不回显。</p><button className="rounded-md border border-border px-3 py-2" onClick={() => setEditing('new')}>新增本地 MCP</button>{connectors.items.map(item => <div key={item.id} className="space-y-2 rounded-md border border-border p-3 text-sm"><p>{item.name}（{item.kind}），{item.enabled ? '启用' : '停用'}，凭据：{item.credentialAvailability}</p>{item.projectId === 'local' && item.id.startsWith('local-') && item.kind === 'mcp' && <div className="flex flex-wrap gap-2"><button disabled={item.config.transport === 'stdio' ? Object.keys(item.config.publicEnvironment).length > 0 : Object.keys(item.config.publicHeaders).length > 0} title="包含已脱敏的公开环境或请求头时，不能从页面安全地原样编辑" onClick={() => setEditing(item)}>编辑</button><button disabled={connectors.credentialCapability !== 'available' || !item.credentialRef} onClick={() => { setCredential(item); setSecret(''); setCredentialId(item.credentialRef ?? `local-key-${item.id.slice(6)}`) }}>设置凭据</button><button onClick={() => setRemoving(item.id)}>删除</button></div>}</div>)}{!connectors.items.length && <p className="text-sm">暂无连接器</p>}
      {editing && <LocalConnectorEditor api={api} existing={editing === 'new' ? undefined : editing} onSaved={() => { setEditing(null); void refreshConnectors().catch(cause => setError(cause instanceof Error ? cause.message : '刷新连接器失败')) }} onCancel={() => setEditing(null)} />}
      {removing && <div role="alert" className="space-y-2 rounded-md border border-border p-3"><p>确认删除本机连接器 {removing}？已保存凭据不会因此自动删除。</p><button disabled={busy} onClick={() => void remove(removing)}>确认删除</button><button onClick={() => setRemoving(null)}>取消</button></div>}
      {credential && <form className="space-y-2 rounded-md border border-border p-3" onSubmit={event => { event.preventDefault(); void storeSecret() }}><h4>设置 {credential.name} 的凭据</h4><p className="text-xs">只支持单字段 Secret；不回填旧值。请先在连接器编辑里配置相同的凭据标识，再写入值。</p><label className="block text-sm">凭据标识<input required value={credentialId} onChange={event => setCredentialId(event.target.value)} className="w-full rounded-md border border-border bg-background p-2" /></label><label className="block text-sm">Secret 值<input type="password" required autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)} className="w-full rounded-md border border-border bg-background p-2" /></label><button disabled={busy || connectors.credentialCapability !== 'available'}>保存密钥</button><button type="button" onClick={() => { setCredential(null); setSecret(''); setCredentialId('') }}>取消</button></form>}
    </div>}
  </section>
}
