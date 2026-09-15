import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Eye, EyeOff, KeyRound, Link2, ShieldCheck } from 'lucide-react'
import { createApi, type ConnectionConfig } from '../api/client'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'

export function ConnectionDialog({ config, onClose, onSave }: { config: ConnectionConfig; onClose: () => void; onSave: (config: ConnectionConfig) => void }) {
  const [token, setToken] = useState(config.token)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showToken, setShowToken] = useState(false)
  const plainHttp = window.location.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)

  const attempt = useRef<{ generation: number; api?: ReturnType<typeof createApi> }>({ generation: 0 })
  const cancel = () => { attempt.current.generation++; attempt.current.api?.dispose(); attempt.current.api = undefined }
  useEffect(() => cancel, [])
  const close = () => { cancel(); onClose() }

  async function connect() {
    cancel()
    const generation = attempt.current.generation
    const api = createApi({ token: token.trim(), teamId: '' })
    attempt.current.api = api
    const active = () => attempt.current.generation === generation
    setBusy(true); setError('')
    try {
      const session = await api.createAdminSession()
      if (!active()) return
      onSave({ token: session.token, teamId: session.teamId, expiresAt: session.expiresAt })
    } catch (cause) {
      if (!active()) return
      const message = cause instanceof Error ? cause.message : '连接失败'
      setError(message.includes('401') ? '管理员令牌无效，请确认它与服务端的 WEMUX_BOOTSTRAP_TOKEN 一致。' : `无法连接服务端：${message}`)
    } finally { api.dispose(); if (active()) setBusy(false) }
  }

  return <Dialog open onOpenChange={open => { if (!open) close() }}><DialogContent className="max-w-lg">
    <DialogHeader><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-indigo-500/10 text-indigo-300"><Link2 className="size-5" /></span><div><DialogTitle>连接服务端</DialogTitle><DialogDescription className="mt-1">输入管理员令牌，连接当前页面所属的 Wemux Lite 服务端。</DialogDescription></div></div></DialogHeader>
    <div className="grid gap-5 p-6">
      <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">服务端地址：<strong className="break-all text-foreground">{window.location.origin}</strong></p>
      <label className="grid gap-2 text-sm"><span className="flex items-center gap-2 font-medium"><KeyRound className="size-4 text-muted-foreground" />管理员令牌</span><span className="relative"><Input autoFocus className="pr-11" type={showToken ? 'text' : 'password'} value={token} onChange={event => setToken(event.target.value)} placeholder="输入 WEMUX_BOOTSTRAP_TOKEN 的值" /><button type="button" className="absolute right-1 top-1 grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={showToken ? '隐藏管理员令牌' : '显示管理员令牌'} onClick={() => setShowToken(value => !value)}>{showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></span><span className="text-xs leading-5 text-muted-foreground">部署服务端时设置的 <code className="rounded bg-muted px-1">WEMUX_BOOTSTRAP_TOKEN</code> 环境变量值。</span></label>
      <p className="flex gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" />管理员密钥只用于换取访问令牌，不会保存在浏览器中。访问令牌默认有效 7 天，过期后需要重新输入管理员密钥。</p>
      {plainHttp && <p className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-5 text-amber-100"><AlertTriangle className="mt-0.5 size-4 shrink-0" />当前为 HTTP 明文连接。令牌和会话内容可能被同一网络中的其他设备看到，仅建议用于可信内网或本机。</p>}
      {error && <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
    </div>
    <DialogFooter><Button variant="outline" onClick={close}>取消</Button><Button disabled={busy || token.trim().length < 16} onClick={() => void connect()}>{busy ? '正在验证连接…' : '连接服务端'}</Button></DialogFooter>
  </DialogContent></Dialog>
}
