import { useState } from 'react'
import type { createLocalSessionApi, LocalProviderCredential, LocalProviderCredentialList } from './local-session.ts'

type Api = ReturnType<typeof createLocalSessionApi>
const fieldPattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const refPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function LocalProviderCredentials({ api, data, refresh }: { api: Api; data: LocalProviderCredentialList; refresh: () => Promise<void> }) {
  const [editing, setEditing] = useState<LocalProviderCredential | 'new' | null>(null)
  const [removing, setRemoving] = useState<LocalProviderCredential | null>(null)
  const [id, setId] = useState('')
  const [names, setNames] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const variables = names.split(',').map(name => name.trim()).filter(Boolean)
  const validVariables = variables.length > 0 && variables.length <= 4 && new Set(variables).size === variables.length && variables.every(name => fieldPattern.test(name) && !name.startsWith('WEMUX_'))
  const ready = refPattern.test(id) && validVariables && variables.every(name => values[name]?.trim())
  const open = (record: LocalProviderCredential | 'new') => {
    setEditing(record); setRemoving(null); setId(record === 'new' ? '' : record.id)
    setNames(record === 'new' ? '' : record.variableNames.join(', ')); setValues({}); setError(''); setNotice('')
  }
  const cancel = () => { setEditing(null); setRemoving(null); setValues({}); setError('') }
  const save = async () => {
    if (!editing || !ready || busy) return
    const expectedRevision = editing === 'new' ? 0 : editing.revision
    const secret = Object.fromEntries(variables.map(name => [name, values[name]!]))
    setValues({}); setBusy(true); setError(''); setNotice('')
    try {
      await api.putProviderCredential(id, variables, secret, expectedRevision)
      await refresh(); setEditing(null); setNotice('凭据已在本机加密保存；尚未验证模型或 Agent 可用性。')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败。密钥未在页面保留，请刷新版本后重新输入。') }
    finally { setBusy(false) }
  }
  const revoke = async () => {
    if (!removing || busy) return
    setBusy(true); setError(''); setNotice('')
    try { await api.deleteProviderCredential(removing.id, removing.revision); await refresh(); setRemoving(null); setNotice('本机凭据已撤销；已通知 Worker 终止集群 Provider 专用 Pi 进程；普通及本地 Agent 会话不因此终止。') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '撤销失败。请刷新列表后重试。') }
    finally { setBusy(false) }
  }
  return <div className="space-y-3 border-t border-border pt-5" aria-label="本地模型凭据">
    <h3 className="font-medium">本地模型凭据</h3>
    <p className="text-sm text-muted-foreground">仅保存在此 Worker 的加密存储中，不传到集群 Server。密钥后端：{data.credentialCapability === 'available' ? '可用' : '未配置'}。保存凭据不等于模型已就绪；Agent 注入和模型探测尚未实现。</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {data.credentialCapability === 'unavailable' && <p role="alert" className="text-sm">需由 Worker 管理员在受信服务环境配置加密密钥，然后重启 Worker；页面不会接收加密主密钥。</p>}
    <button type="button" disabled={busy || data.credentialCapability !== 'available'} className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => open('new')}>添加凭据</button>
    {!data.items.length && <p className="text-sm text-muted-foreground">尚无本机模型凭据。先在集群资源定义中设置一致的本地凭据引用和变量名。</p>}
    {data.items.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-sm"><div><strong className="font-medium">{item.id}</strong><p className="text-muted-foreground">{item.variableNames.join('、')} · 版本 {item.revision} · {item.availability === 'available' ? '本机可解密' : '不可解密或密钥不可用'}</p></div><div className="flex gap-2"><button type="button" disabled={busy || data.credentialCapability !== 'available'} className="rounded-md border border-border px-3 py-2" onClick={() => open(item)}>轮换</button><button type="button" disabled={busy} className="rounded-md border border-border px-3 py-2" onClick={() => { setRemoving(item); setEditing(null); setValues({}); setError(''); setNotice('') }}>撤销</button></div></div>)}
    {editing && <form className="space-y-3 border-t border-border pt-3" onSubmit={event => { event.preventDefault(); void save() }}><h4 className="font-medium">{editing === 'new' ? '添加本机凭据' : `轮换 ${editing.id}`}</h4><p className="text-sm text-muted-foreground">变量名须与 Provider 资源声明完全一致，最多 4 个。旧值不会回填；轮换时必须重新输入全部字段。</p><label className="block space-y-1 text-sm">凭据引用<input className="w-full rounded-md border border-border bg-background p-2" autoComplete="off" value={id} onChange={event => setId(event.target.value)} readOnly={editing !== 'new'} required /></label><label className="block space-y-1 text-sm">环境变量名（逗号分隔）<input className="w-full rounded-md border border-border bg-background p-2" autoComplete="off" value={names} onChange={event => { setNames(event.target.value); setValues({}) }} required /></label>{names && !validVariables && <p className="text-sm text-destructive">请输入 1–4 个不重复且不以 WEMUX_ 开头的合法变量名。</p>}{validVariables && variables.map(name => <label key={name} className="block space-y-1 text-sm">{name} 的密钥<input type="password" autoComplete="off" className="w-full rounded-md border border-border bg-background p-2" value={values[name] ?? ''} onChange={event => setValues(previous => ({ ...previous, [name]: event.target.value }))} required /></label>)}<div className="flex gap-2"><button disabled={busy || !ready || data.credentialCapability !== 'available'} className="rounded-md border border-border px-3 py-2">加密保存</button><button type="button" onClick={cancel} className="rounded-md border border-border px-3 py-2">取消</button></div></form>}
    {removing && <div role="alert" className="space-y-2 border-t border-border pt-3 text-sm"><p>确认撤销本机凭据 {removing.id}？其引用仍可能留在集群 Provider 资源中；Worker 将终止集群 Provider 专用 Pi 进程；普通及本地 Agent 会话不因此终止。</p><button type="button" disabled={busy} onClick={() => void revoke()} className="rounded-md border border-border px-3 py-2">确认撤销</button><button type="button" onClick={cancel} className="rounded-md border border-border px-3 py-2">取消</button></div>}
  </div>
}
