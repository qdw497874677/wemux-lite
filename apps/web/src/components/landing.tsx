import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Eye, EyeOff, FolderGit2, KeyRound, MessagesSquare, Network, ShieldCheck } from 'lucide-react'
import { createApi, type ConnectionConfig } from '../api/client'
import { Button } from './ui/button'
import { Input } from './ui/input'

// 落地页：未连接时的首屏。连接动作是页面级内联表单，不依赖任何弹窗组件，
// 避免首次访问时因资源加载问题导致“点击无响应”。
export function LandingScreen({ config, onSave }: { config: ConnectionConfig; onSave: (config: ConnectionConfig) => void }) {
  const [token, setToken] = useState(config.token)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showToken, setShowToken] = useState(false)
  const plainHttp = window.location.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)

  const attempt = useRef<{ generation: number; api?: ReturnType<typeof createApi> }>({ generation: 0 })
  const cancel = () => { attempt.current.generation++; attempt.current.api?.dispose(); attempt.current.api = undefined }
  useEffect(() => cancel, [])

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

  return <main className="landing-root grain-overlay" aria-labelledby="landing-title">
    <div className="landing-grid">
      <section className="landing-intro">
        <p className="flex items-center gap-3"><span aria-hidden className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-lg font-black text-white shadow-[0_2px_12px_hsl(244_75%_64%_/.3)]">W</span><strong className="text-base tracking-tight">Wemux Lite</strong></p>
        <h1 id="landing-title" className="text-3xl font-bold leading-tight tracking-tight sm:text-4xl">自托管的智能体协作控制台</h1>
        <p className="max-w-xl text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">注册工作节点、组织项目与工作区，和运行在各节点上的智能体对话，并在任务看板上完成分派与人工审查。</p>
        <ul>
          <li className="flex items-start gap-3"><span className="landing-feature-icon" aria-hidden><Network className="size-4" /></span><span className="pt-1 text-sm leading-6">工作节点注册与探活，智能体和模型清单自动上报</span></li>
          <li className="flex items-start gap-3"><span className="landing-feature-icon" aria-hidden><FolderGit2 className="size-4" /></span><span className="pt-1 text-sm leading-6">项目到工作区到会话的统一层级，跨节点集中管理</span></li>
          <li className="flex items-start gap-3"><span className="landing-feature-icon" aria-hidden><MessagesSquare className="size-4" /></span><span className="pt-1 text-sm leading-6">与任意节点上的智能体对话，执行过程与人工审查留痕</span></li>
        </ul>
      </section>
      <form className="landing-card" noValidate onSubmit={event => { event.preventDefault(); if (busy) return; if (token.trim().length < 16) { setError('管理员令牌长度不足，请粘贴启动服务端时设置的完整 WEMUX_BOOTSTRAP_TOKEN 值。'); return } void connect() }}>
        <h2 className="text-lg font-semibold">连接服务端</h2>
        <p className="-mt-1 text-sm leading-6 text-muted-foreground">输入管理员令牌进入控制台。</p>
        <label className="text-xs font-medium text-muted-foreground">服务端地址</label>
        <p className="break-all rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">{window.location.origin}</p>
        <label htmlFor="landing-token" className="flex items-center gap-2 text-sm font-medium"><KeyRound aria-hidden className="size-4 text-muted-foreground" />管理员令牌</label>
        <span className="relative block">
          <Input id="landing-token" autoFocus type={showToken ? 'text' : 'password'} className="pr-11" value={token} onChange={event => { setToken(event.target.value); setError('') }} placeholder="输入 WEMUX_BOOTSTRAP_TOKEN 的值" aria-invalid={Boolean(error) || undefined} />
          <button type="button" className="absolute right-1 top-1 grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={showToken ? '隐藏管理员令牌' : '显示管理员令牌'} onClick={() => setShowToken(value => !value)}>{showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>
        </span>
        <p className="text-xs leading-5 text-muted-foreground">即启动服务端时设置的 <code className="rounded bg-muted px-1">WEMUX_BOOTSTRAP_TOKEN</code> 环境变量值。</p>
        <p className="flex gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground"><ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-400" /><span>管理员密钥只用于换取访问令牌，不会保存在浏览器中。访问令牌默认有效 7 天，过期后需要重新输入。</span></p>
        {plainHttp && <p className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-5 text-amber-100"><AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />当前为 HTTP 明文连接，令牌可能被同网络设备看到，仅建议用于可信内网或本机。</p>}
        {error && <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
        <Button type="submit" className="press-feedback h-10 w-full text-sm font-semibold" disabled={busy}>{busy ? '正在验证连接…' : '连接并进入控制台'}</Button>
      </form>
    </div>
  </main>
}
