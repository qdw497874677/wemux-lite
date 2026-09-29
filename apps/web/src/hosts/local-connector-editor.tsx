import { useState } from 'react'
import { randomId } from '../lib/random.ts'
import type { createLocalSessionApi, LocalConnectorDefinition } from './local-session.ts'

type Api = ReturnType<typeof createLocalSessionApi>

export function LocalConnectorEditor({ api, existing, onSaved, onCancel }: { api: Api; existing?: LocalConnectorDefinition; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(existing?.name ?? '')
  const [transport, setTransport] = useState<'stdio' | 'streamable_http'>(existing?.config.transport ?? 'stdio')
  const [command, setCommand] = useState(existing?.config.transport === 'stdio' ? existing.config.command : '')
  const [args, setArgs] = useState(existing?.config.transport === 'stdio' ? existing.config.args.join('\n') : '')
  const [url, setUrl] = useState(existing?.config.transport === 'streamable_http' ? existing.config.url : '')
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [secretEnvironmentNames, setSecretEnvironmentNames] = useState(existing?.config.transport === 'stdio' ? existing.config.secretEnvironmentNames.join('\n') : '')
  const [credentialRef, setCredentialRef] = useState(existing?.credentialRef ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const now = new Date().toISOString()
      const config: LocalConnectorDefinition['config'] = transport === 'stdio'
        ? { transport, command: command.trim(), args: args.split('\n').map(value => value.trim()).filter(Boolean), cwd: existing?.config.transport === 'stdio' ? existing.config.cwd : null, publicEnvironment: existing?.config.transport === 'stdio' ? existing.config.publicEnvironment : {}, secretEnvironmentNames: secretEnvironmentNames.split('\n').map(value => value.trim()).filter(Boolean) }
        : { transport, url: url.trim(), publicHeaders: existing?.config.transport === 'streamable_http' ? existing.config.publicHeaders : {}, authentication: credentialRef.trim() ? (existing?.config.transport === 'streamable_http' && existing.config.authentication !== 'none' ? existing.config.authentication : 'custom_credential') : 'none', allowPrivateNetwork: existing?.config.transport === 'streamable_http' ? existing.config.allowPrivateNetwork : false }
      await api.saveConnector({ id: existing?.id ?? `local-${randomId()}`, projectId: 'local', kind: 'mcp', name: name.trim(), description: existing?.description ?? null, revision: (existing?.revision ?? 0) + 1, enabled, allowedWorkerIds: [], credentialRef: credentialRef.trim() || null, credentialAvailability: credentialRef.trim() ? (existing?.credentialAvailability === 'available' && credentialRef.trim() === existing.credentialRef ? 'available' : 'unconfigured') : 'not_required', riskDefaults: existing?.riskDefaults ?? { requireApprovalForRead: false, allowMcpReadOnlyHint: false }, createdAt: existing?.createdAt ?? now, updatedAt: now, config })
      onSaved()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '连接器保存失败') }
    finally { setBusy(false) }
  }
  return <form className="space-y-3 rounded-md border border-border p-3" onSubmit={event => { event.preventDefault(); void save() }}>
    <h4 className="font-medium">{existing ? '编辑本地 MCP 连接器' : '新增本地 MCP 连接器'}</h4>
    <label className="block text-sm">名称<input className="mt-1 w-full rounded-md border border-border bg-background p-2" required maxLength={200} value={name} onChange={event => setName(event.target.value)} /></label>
    <label className="block text-sm">连接方式<select className="mt-1 w-full rounded-md border border-border bg-background p-2" value={transport} onChange={event => setTransport(event.target.value as 'stdio' | 'streamable_http')}><option value="stdio">本地命令（stdio）</option><option value="streamable_http">HTTP（streamable_http）</option></select></label>
    {transport === 'stdio' ? <><label className="block text-sm">可执行文件<input className="mt-1 w-full rounded-md border border-border bg-background p-2" required value={command} onChange={event => setCommand(event.target.value)} /></label><label className="block text-sm">参数（每行一项）<textarea className="mt-1 w-full rounded-md border border-border bg-background p-2" value={args} onChange={event => setArgs(event.target.value)} /></label><label className="block text-sm">Secret 环境变量名（每行一项，不填写值）<textarea className="mt-1 w-full rounded-md border border-border bg-background p-2" value={secretEnvironmentNames} onChange={event => setSecretEnvironmentNames(event.target.value)} /></label></> : <label className="block text-sm">HTTP URL<input className="mt-1 w-full rounded-md border border-border bg-background p-2" type="url" required value={url} onChange={event => setUrl(event.target.value)} /></label>}
    <label className="block text-sm">本机凭据标识（可选，例如 local-key-myapp）<input className="mt-1 w-full rounded-md border border-border bg-background p-2" value={credentialRef} onChange={event => setCredentialRef(event.target.value)} /></label>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用连接器</label>
    <p className="text-xs text-muted-foreground">仅编辑本机 MCP。只修改名称、启用状态、命令参数或 URL；其余已有配置保持不变。集群下发的连接器不可在此修改。请确认命令及目标 URL 可信。</p>
    {error && <p role="alert">{error}</p>}
    <div className="flex gap-2"><button disabled={busy} className="rounded-md border border-border px-3 py-2">保存连接器</button><button type="button" className="rounded-md border border-border px-3 py-2" onClick={onCancel}>取消</button></div>
  </form>
}
