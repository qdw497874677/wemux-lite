import { useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, LogIn, Mail, MailCheck, UserRound } from 'lucide-react'
import { ApiError, anonymousSession, createApi, type AccountSession } from '../api/client'
import type { AccountPayloadDTO, AccountViewDTO, GoogleCapabilityDTO, RegistrationCapabilitiesDTO } from '../api/dto'
import { Button } from './ui/button'
import { Input } from './ui/input'

export type AuthMode = 'login' | 'register' | 'forgot'

/** 服务端账号响应 → 浏览器内存里的会话作用域。登录令牌始终只在 HttpOnly Cookie 中。 */
export function toAccountSession(account: AccountPayloadDTO | AccountViewDTO): AccountSession {
  return { teamId: account.teamId ?? '', csrfToken: account.csrfToken ?? '', username: account.user.username, email: account.user.email, instanceAdministrator: account.instanceAdministrator }
}

const failureText = (cause: unknown, mode: AuthMode): string => {
  if (cause instanceof ApiError) {
    if (cause.status === 401) return '账号或密码不正确，请重试。'
    if (cause.status === 409) return cause.message.replace(/^请求失败（HTTP 409）：/, '')
    if (cause.status === 429) return '尝试次数过多，请等待几分钟后再试。'
    // 邮件投递失败（502）与未配置投递（503）必须原样说明，不能显示成“邮件已发送”。
    if (cause.status === 502 || cause.status === 503) return cause.message.replace(/^请求失败（HTTP \d+）：/, '')
    return cause.message
  }
  return cause instanceof Error ? cause.message : '认证失败'
}

const hoursOf = (ms: number): string => `${Math.max(1, Math.round(ms / (60 * 60 * 1000)))} 小时`
const minutesOf = (ms: number): string => `${Math.max(1, Math.round(ms / (60 * 1000)))} 分钟`

/**
 * 落地页与弹窗共用的凭据表单。登录只需要账号与密码；注册与找回只在实例开放
 * 且邮件投递可用时出现（由调用方通过 capabilities 决定）。没有初始化形态：
 * 授权根是部署声明的管理员邮箱，实例从第一次启动起就可以直接登录或注册。
 * 表单不持有任何长期状态：成功后由调用方把会话写入内存并重挂工作台。
 */
export function AuthForm({ mode, minimumLength = 15, capabilities, google, submitLabel, onAuthenticated, onSwitchMode }: {
  mode: AuthMode
  /** 默认值与服务端 `passwordPolicy.minimumLength` 一致，能以 `/auth/options` 为准时就传入真实值。 */
  minimumLength?: number
  /** 注册与邮件能力；缺省时按未配置投递处理，如实说明而不是假装能发信。 */
  capabilities?: RegistrationCapabilitiesDTO | null
  /** Google 登录能力；未配置时不渲染按钮，避免出现点了报错的假入口。 */
  google?: GoogleCapabilityDTO | null
  submitLabel: string
  onAuthenticated: (account: AccountPayloadDTO) => void
  onSwitchMode?: (mode: AuthMode) => void
}) {
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [sent, setSent] = useState<{ kind: 'register' | 'forgot'; email: string } | null>(null)
  const attempt = useRef<{ generation: number; api?: ReturnType<typeof createApi> }>({ generation: 0 })
  const cancel = () => { attempt.current.generation++; attempt.current.api?.dispose(); attempt.current.api = undefined }
  useEffect(() => cancel, [])

  const minimum = capabilities?.passwordMinimumLength ?? minimumLength
  const local = (): string => {
    if (mode === 'register') {
      if (!email.trim().includes('@')) return '请输入有效的邮箱地址。'
      if (displayName.trim().length === 0) return '请输入显示名称。'
      if (displayName.trim().length > 64) return '显示名称不能超过 64 个字符。'
      if (password.length < minimum) return `密码至少需要 ${minimum} 个字符。`
      if (password !== confirm) return '两次输入的密码不一致。'
      if (capabilities && !capabilities.emailDelivery) return `本实例未配置邮件投递（${capabilities.emailDeliveryReason ?? '原因未知'}），无法自助注册。`
      return ''
    }
    if (mode === 'forgot') {
      if (!email.trim().includes('@')) return '请输入有效的邮箱地址。'
      if (capabilities && !capabilities.emailDelivery) return `本实例未配置邮件投递（${capabilities.emailDeliveryReason ?? '原因未知'}），无法发送重置邮件。`
      return ''
    }
    if (!login.trim()) return '请输入账号名或邮箱。'
    if (!password) return '请输入密码。'
    return ''
  }

  async function submit() {
    const invalid = local()
    if (invalid) { setError(invalid); return }
    cancel()
    const generation = attempt.current.generation
    const api = createApi(anonymousSession())
    attempt.current.api = api
    setBusy(mode); setError('')
    try {
      if (mode === 'register') {
        const accepted = await api.register({ email: email.trim(), displayName: displayName.trim(), password })
        if (attempt.current.generation !== generation) return
        setPassword(''); setConfirm('')
        setSent({ kind: 'register', email: accepted.email })
        return
      }
      if (mode === 'forgot') {
        const accepted = await api.forgotPassword(email.trim())
        if (attempt.current.generation !== generation) return
        setSent({ kind: 'forgot', email: accepted.email })
        return
      }
      const account = await api.login(login.trim(), password)
      if (attempt.current.generation !== generation) return
      setPassword(''); setConfirm('')
      onAuthenticated(account)
    } catch (cause) {
      if (attempt.current.generation !== generation) return
      setError(failureText(cause, mode))
    } finally { api.dispose(); if (attempt.current.generation === generation) setBusy('') }
  }

  async function startGoogle() {
    cancel()
    const generation = attempt.current.generation
    const api = createApi(anonymousSession())
    attempt.current.api = api
    setBusy('google'); setError('')
    try {
      // 回到当前地址（含查询串）：未登录时落地页就渲染在原始深链上，登录后要回到同一处。
      const started = await api.startGoogleSignIn(`${window.location.pathname}${window.location.search}`)
      if (attempt.current.generation !== generation) return
      window.location.assign(started.authorizeUrl)
    } catch (cause) {
      if (attempt.current.generation !== generation) return
      setError(failureText(cause, mode))
    } finally { api.dispose(); if (attempt.current.generation === generation) setBusy('') }
  }

  async function resend() {
    if (!sent) return
    cancel()
    const generation = attempt.current.generation
    const api = createApi(anonymousSession())
    attempt.current.api = api
    setBusy('resend'); setError('')
    try {
      const accepted = await api.resendVerification(sent.email)
      if (attempt.current.generation !== generation) return
      setSent({ kind: 'register', email: accepted.email })
      setError('')
      setNotice('已重新发送验证邮件。')
    } catch (cause) {
      if (attempt.current.generation !== generation) return
      setError(failureText(cause, 'register'))
    } finally { api.dispose(); if (attempt.current.generation === generation) setBusy('') }
  }
  const secretField = (id: string, label: string, value: string, onChange: (value: string) => void, placeholder: string, autoComplete: string) =>
    <>
      <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium">{label}</label>
      <span className="relative block">
        <Input id={id} type={showSecret ? 'text' : 'password'} className="w-full pr-11" value={value} placeholder={placeholder} autoComplete={autoComplete}
          onChange={event => { onChange(event.target.value); setError(''); setNotice('') }} aria-invalid={Boolean(error) || undefined} />
        <button type="button" className="absolute right-1 top-1 grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={showSecret ? '隐藏密码' : '显示密码'} onClick={() => setShowSecret(value => !value)}>{showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>
      </span>
    </>

  if (sent) {
    const ttl = sent.kind === 'register' ? hoursOf(capabilities?.verificationTtlMs ?? 24 * 60 * 60 * 1000) : minutesOf(capabilities?.resetTtlMs ?? 30 * 60 * 1000)
    return <div className="grid gap-3" role="status">
      <p className="flex items-center gap-2 text-sm font-medium"><MailCheck aria-hidden className="size-4 text-emerald-400" />{sent.kind === 'register' ? '验证邮件已发送' : '重置链接已发送'}</p>
      <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm leading-6 text-muted-foreground">
        {sent.kind === 'register'
          ? `如果 ${sent.email} 可以用于注册，验证邮件已经发出。链接 ${ttl}内有效，且只能使用一次。`
          : `如果 ${sent.email} 对应一个本机账号，重置链接已经发出。链接 ${ttl}内有效，且只能使用一次。`}
      </p>
      {error && <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
      {notice && <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">{notice}</p>}
      <div className="flex flex-wrap gap-2">
        {sent.kind === 'register' && <Button type="button" variant="outline" className="h-10 text-sm" disabled={busy !== ''} onClick={() => void resend()}>{busy === 'resend' ? '正在重发…' : '重发验证邮件'}</Button>}
        {onSwitchMode && <Button type="button" className="press-feedback h-10 text-sm font-semibold" onClick={() => { setSent(null); setNotice(''); setError(''); onSwitchMode('login') }}>返回登录</Button>}
      </div>
    </div>
  }

  return <form className="grid gap-3" noValidate onSubmit={event => { event.preventDefault(); if (!busy) void submit() }}>
    {error && <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
    {mode === 'register' ? <>
      <label htmlFor="auth-email" className="flex items-center gap-2 text-sm font-medium"><Mail aria-hidden className="size-4 text-muted-foreground" />邮箱</label>
      <Input id="auth-email" type="email" value={email} placeholder="you@example.com" autoComplete="email"
        onChange={event => { setEmail(event.target.value); setError('') }} />
      <label htmlFor="auth-display" className="flex items-center gap-2 text-sm font-medium"><UserRound aria-hidden className="size-4 text-muted-foreground" />显示名称</label>
      <Input id="auth-display" value={displayName} placeholder="在团队里显示的名字" autoComplete="nickname"
        onChange={event => { setDisplayName(event.target.value); setError('') }} />
      {secretField('auth-password', '设置密码', password, setPassword, `至少 ${minimum} 个字符`, 'new-password')}
      {secretField('auth-confirm', '确认密码', confirm, setConfirm, '再次输入密码', 'new-password')}
      <p className="text-xs leading-5 text-muted-foreground">注册后账号处于待验证状态：点击邮件里的确认按钮才会创建可登录账号。新账号不会自动加入任何团队或项目；如果这个邮箱正是部署时声明的管理员邮箱，验证后该账号即获得实例管理员权限。</p>
    </> : mode === 'forgot' ? <>
      <label htmlFor="auth-email" className="flex items-center gap-2 text-sm font-medium"><Mail aria-hidden className="size-4 text-muted-foreground" />邮箱</label>
      <Input id="auth-email" type="email" value={email} placeholder="注册时使用的邮箱" autoComplete="email"
        onChange={event => { setEmail(event.target.value); setError('') }} />
      <p className="text-xs leading-5 text-muted-foreground">我们会向该邮箱发送一次性重置链接；无论邮箱是否存在，响应都一样。</p>
    </> : <>
      <label htmlFor="auth-login" className="flex items-center gap-2 text-sm font-medium"><UserRound aria-hidden className="size-4 text-muted-foreground" />账号或邮箱</label>
      <Input id="auth-login" value={login} placeholder="账号名或邮箱" autoComplete="username"
        onChange={event => { setLogin(event.target.value); setError('') }} />
      {secretField('auth-password', '密码', password, setPassword, '输入密码', 'current-password')}
    </>}
    <Button type="submit" className="press-feedback h-10 w-full text-sm font-semibold" disabled={busy !== ''}>{busy ? '正在提交…' : submitLabel}</Button>
    {mode === 'login' && google?.enabled && <>
      <p className="flex items-center gap-3 text-xs text-muted-foreground"><span aria-hidden className="h-px flex-1 bg-border" />或<span aria-hidden className="h-px flex-1 bg-border" /></p>
      <Button type="button" variant="outline" className="h-10 w-full text-sm" disabled={busy !== ''} onClick={() => void startGoogle()}>
        <LogIn aria-hidden className="size-4" />{busy === 'google' ? '正在跳转 Google…' : '使用 Google 继续'}
      </Button>
      <p className="text-xs leading-5 text-muted-foreground">未注册过的 Google 邮箱是否可建号，取决于本实例的注册策略；已有账号直接登录。</p>
    </>}
    {onSwitchMode && (mode === 'login' || mode === 'register' || capabilities?.emailDelivery) && <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
      {capabilities?.emailDelivery && mode === 'login' && <button type="button" className="underline decoration-dotted underline-offset-4" onClick={() => { setError(''); onSwitchMode('forgot') }}>忘记密码？</button>}
      {capabilities?.emailDelivery && mode === 'forgot' && <button type="button" className="underline decoration-dotted underline-offset-4" onClick={() => { setError(''); onSwitchMode('login') }}>返回登录</button>}
      {mode === 'register' && <button type="button" className="underline decoration-dotted underline-offset-4" onClick={() => { setError(''); onSwitchMode('login') }}>已经有账号？改为登录</button>}
    </div>}
  </form>
}