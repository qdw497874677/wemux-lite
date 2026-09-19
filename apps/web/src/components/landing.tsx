import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, FolderGit2, Mail, MessagesSquare, Network, ShieldCheck } from 'lucide-react'
import { anonymousSession, createApi } from '../api/client'
import type { AccountPayloadDTO, AuthOptionsDTO } from '../api/dto'
import { readOauthError, withoutOauthError } from '../lib/oauth-error'
import { AuthForm, type AuthMode } from './auth-form'
import { Button } from './ui/button'

// 落地页：未登录时的首屏。认证动作是页面级内联表单，不依赖任何弹窗组件，
// 避免访问时因资源加载问题导致“点击无响应”。授权根是启动配置里声明的管理员邮箱
// （`WEMUX_ADMIN_EMAILS`，“部署者即管理员”）：没有引导令牌、没有首次认领表单，
// 实例从第一次启动起就能直接登录或注册。
// Ticket 05 起实例可以开放邮箱注册：注册与找回只在策略开放且邮件投递可用时出现。
// Ticket 07 起可以配置 Google 登录：未配置时不渲染按钮；回调失败的错误码由跳转地址带回这里展示一次。
export function LandingScreen({ notice, onAuthenticated }: { notice?: string; onAuthenticated: (account: AccountPayloadDTO) => void }) {
  const [options, setOptions] = useState<AuthOptionsDTO | null>(null)
  const [probeError, setProbeError] = useState('')
  const [mode, setMode] = useState<AuthMode>('login')
  const [attempt, setAttempt] = useState(0)
  const [oauthError, setOauthError] = useState(() => readOauthError(window.location.search))
  const plainHttp = window.location.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
  // 错误只展示一次：立刻从地址栏去掉，刷新页面不会反复弹出已经处理过的旧错误。
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('oauth_error')) return
    window.history.replaceState(null, '', withoutOauthError(window.location.pathname, window.location.search))
  }, [])

  const probe = useCallback(() => {
    const api = createApi(anonymousSession())
    let active = true
    setProbeError('')
    void (async () => {
      try {
        const value = await api.authOptions()
        if (!active) return
        setOptions(value)
      } catch (cause) {
        if (!active) return
        setProbeError(cause instanceof Error ? cause.message : '无法读取服务端状态')
      } finally { api.dispose() }
    })()
    return () => { active = false; api.dispose() }
  }, [])
  useEffect(() => probe(), [probe, attempt])

  const registration = options?.registration ?? null
  // 声明了管理员邮箱但还没对应账号：部署者本人的首次访问应该知道该用哪个邮箱。这里不泄露邮箱本身。
  const administratorUnregistered = options?.administratorConfigured === true && options.administratorRegistered === false
  const administratorMissing = options?.administratorConfigured === false
  const closedReason = registration && registration.registrationPolicy === 'invite_only'
    ? administratorUnregistered
      // 只邀请不是“也没你能进的门”：声明邮箱是策略的例外，服务端也按这个例外执行。
      ? '本实例目前只允许邀请注册；部署时声明的管理员邮箱是例外，可直接注册或登录。'
      : '本实例目前只允许邀请注册，请联系实例管理员。'
    : registration && registration.registrationPolicy === 'closed' ? '本实例已关闭注册。' : ''
  const mailReason = registration && !registration.emailDelivery && !closedReason
    ? `邮件投递不可用（${registration.emailDeliveryReason ?? '未配置'}），自助注册与找回密码暂时无法使用。`
    : ''
  // 注册入口的可见条件与服务端的例外一致：策略开放时人人可注册；策略仅邀请但声明邮箱还没建号时，
  // 部署者必须能走到注册表单（否则第一次启动的实例谁也当不成管理员）。其他人提交同表单会被策略拒绝。
  const declaredFirstRun = administratorUnregistered && registration?.emailDelivery === true
  const multipleModes = Boolean(registration && registration.emailDelivery && (registration.registrationPolicy === 'open' || declaredFirstRun))
  const minimumLength = registration?.passwordMinimumLength ?? options?.passwordMinimumLength ?? 15
  const heading = mode === 'register' ? '创建账号' : mode === 'forgot' ? '找回密码' : '登录控制台'
  const blurb = mode === 'register' ? '用邮箱注册，收到验证邮件并确认后才会创建可登录账号。'
    : mode === 'forgot' ? '输入注册邮箱，我们会发送一次性重置链接。'
      : '使用账号密码登录，浏览器只保存 HttpOnly 会话 Cookie。'
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
      <section className="landing-card">
        <h2 className="text-lg font-semibold">{heading}</h2>
        <p className="-mt-1 text-sm leading-6 text-muted-foreground">{blurb}</p>
        <label className="text-xs font-medium text-muted-foreground">服务端地址</label>
        <p className="break-all rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">{window.location.origin}</p>
        {notice && <p role="status" className="rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">{notice}</p>}
        {oauthError && <p role="alert" className="flex gap-2 rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-xs leading-5 text-red-200"><AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" /><span>{oauthError}</span></p>}
        {closedReason && <p className="flex gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground"><AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-300" />{closedReason}</p>}
        {mailReason && <p className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-5 text-amber-100"><AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />{mailReason}</p>}
        {administratorUnregistered && <p className="flex gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground"><ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-indigo-300" />本实例的管理员已由部署声明，但对应账号还没建立。请用部署时声明的那个邮箱注册或登录，该账号会自动获得实例管理员权限。</p>}
        {administratorMissing && <p className="flex gap-2 rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-xs leading-5 text-red-200"><AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />本实例未声明管理员邮箱，无法登录控制台。请重启服务端并设置 WEMUX_ADMIN_EMAILS。</p>}
        {options === null
          ? <div className="grid gap-3">
            {probeError
              ? <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-200">{probeError}</p>
              : <p role="status" className="text-sm text-muted-foreground">正在读取服务端状态…</p>}
            <Button type="button" variant="outline" className="h-10 w-full text-sm" onClick={() => setAttempt(value => value + 1)}>重新检查服务端</Button>
          </div>
          : <AuthForm mode={mode} minimumLength={minimumLength} capabilities={registration} google={options.google} submitLabel={mode === 'register' ? '发送验证邮件' : mode === 'forgot' ? '发送重置链接' : '登录'}
            onAuthenticated={account => onAuthenticated(account)} onSwitchMode={setMode} />}
        {options !== null && multipleModes && mode !== 'register' && mode !== 'forgot' && <button type="button" className="flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setMode('register')}><Mail aria-hidden className="size-4" />还没有账号？用邮箱注册</button>}
        {mode === 'login' && oauthError && <p className="text-xs leading-5 text-muted-foreground">只想用密码登录？直接在上方输入账号或邮箱即可，两次 Google 登录失败不代表账号不可用。</p>}
        <p className="flex gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground"><ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-400" /><span>登录会话存放在 HttpOnly Cookie 中，页面脚本读不到；写操作额外校验 CSRF 令牌。</span></p>
        {plainHttp && <p className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-5 text-amber-100"><AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />当前为 HTTP 明文连接，账号密码可能被同网络设备看到，仅建议用于可信内网或本机。</p>}
      </section>
    </div>
  </main>
}