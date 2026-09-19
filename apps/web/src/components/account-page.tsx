import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Link2, LogOut, Mail, MonitorSmartphone, RefreshCw, ShieldCheck, UserRound } from 'lucide-react'
import type { Api, AccountSession } from '../api/client'
import type { AccountSecurityViewDTO, RegistrationPolicyDTO } from '../api/dto'
import { formatChineseTime } from '../lib/display'
import { readLinkError, readLinkNotice, withoutLinkParams } from '../lib/oauth-error'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'

/** 服务端 4xx/5xx 文案本身就是可展示的中文，这里只去掉客户端加的状态码前缀。 */
const errorText = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^请求失败（HTTP \d+）：/, '') : '请求失败'
const policyLabels: Record<RegistrationPolicyDTO, string> = { open: '开放注册', invite_only: '仅邀请', closed: '关闭注册' }
const methodLabels: Record<string, string> = { password: '本地密码', google: 'Google' }
const minutesLeft = (expiresAt: string): string => {
  const left = Math.round((Date.parse(expiresAt) - Date.now()) / 60000)
  return Number.isFinite(left) && left > 0 ? `${left} 分钟` : '几分钟'
}

/**
 * 全局设置里的账号面板入口：把 Google 绑定回调带回的地址栏参数一次性翻译成人话并立刻清掉，
 * 这样刷新不会复现提示，链接被分享出去也不会携带别人的绑定结果（Ticket 08）。
 */
export function AccountSettingsRoute({ api, session, onSignOut, onOpenConnection }: {
  api: Api
  session: AccountSession
  onSignOut: () => void
  onOpenConnection: () => void
}) {
  const [notice, setNotice] = useState(() => readLinkNotice(window.location.search))
  const [failure, setFailure] = useState(() => readLinkError(window.location.search))
  useEffect(() => {
    if (!notice && !failure) return
    window.history.replaceState(null, '', withoutLinkParams(window.location.pathname, window.location.search))
  }, [notice, failure])
  return <><h1>全局设置</h1><AccountPage api={api} session={session} onSignOut={onSignOut} onOpenConnection={onOpenConnection} linkNotice={notice} linkError={failure} /></>
}

/**
 * 全局设置页里的账号面板（Ticket 04）：只展示可安全披露的会话视图，
 * 登录令牌或其哈希永远不会到达这里。退出与撤销都经由 Cookie 会话 API。
 * Ticket 05 增加实例级注册策略（只对实例管理员显示，非管理员由服务端返回 403）。
 * Ticket 06/08 增加账号安全：改密码、改邮箱（邮件确认后才生效）、绑定与解绑 Google。
 * 强认证判定全在服务端：页面只负责把“需要当前密码”如实提示出来，不做本地放行。
 */
export function AccountPage({ api, session, onSignOut, onOpenConnection, linkNotice = '', linkError = '' }: {
  api: Api
  session: AccountSession
  onSignOut: () => void
  onOpenConnection: () => void
  /** Google 绑定回调带回的结果，只在刚跳回设置页时显示一次；地址栏参数由调用方清理。 */
  linkNotice?: string
  linkError?: string | null
}) {
  const client = useQueryClient()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(linkError ?? '')
  const [notice, setNotice] = useState(linkNotice)
  const [passwordForm, setPasswordForm] = useState({ current: '', next: '', confirm: '' })
  const [emailForm, setEmailForm] = useState({ email: '', current: '' })
  const [unbinding, setUnbinding] = useState<{ id: string; kind: string } | null>(null)
  const [unbindPassword, setUnbindPassword] = useState('')
  const sessions = useQuery({ queryKey: ['login-sessions'], queryFn: ({ signal }) => api.loginSessions(signal) })
  const policy = useQuery({ queryKey: ['registration-policy'], queryFn: ({ signal }) => api.registrationPolicy(signal), enabled: session.instanceAdministrator })
  const capabilities = useQuery({ queryKey: ['auth-options'], queryFn: ({ signal }) => api.authOptions(signal) })
  const security = useQuery({ queryKey: ['account-security'], queryFn: ({ signal }) => api.accountSecurity(signal) })

  const view: AccountSecurityViewDTO | undefined = security.data
  const minimum = capabilities.data?.registration?.passwordMinimumLength ?? 15
  const passwordSet = view?.passwordSet ?? true

  const act = async (label: string, run: () => Promise<unknown>, after?: () => void | Promise<void>) => {
    setBusy(label); setError(''); setNotice('')
    try { await run(); if (after) await after(); else await client.invalidateQueries({ queryKey: ['login-sessions'] }) }
    catch (cause) { setError(errorText(cause)) }
    finally { setBusy('') }
  }

  const submitPassword = () => void act('password', async () => {
    if (passwordForm.next.length < minimum) throw new Error(`新密码至少需要 ${minimum} 个字符。`)
    if (passwordForm.next !== passwordForm.confirm) throw new Error('两次输入的新密码不一致。')
    const result = await api.changePassword({ currentPassword: passwordSet ? passwordForm.current : undefined, newPassword: passwordForm.next })
    setPasswordForm({ current: '', next: '', confirm: '' })
    // 撤销数量如实回显：用户需要知道别的设备已经被踢下线，而不是靠猜。
    setNotice(`密码已更新。其它设备上的 ${result.revokedSessions} 个会话与 ${result.revokedTokens} 个访问令牌已撤销，当前设备保持登录。`)
    await client.invalidateQueries({ queryKey: ['login-sessions'] })
    await client.invalidateQueries({ queryKey: ['account-security'] })
  })

  const submitEmail = () => void act('email', async () => {
    if (!emailForm.email.includes('@')) throw new Error('请输入有效的邮箱地址。')
    const accepted = await api.requestEmailChange({ newEmail: emailForm.email.trim(), currentPassword: passwordSet ? emailForm.current : undefined })
    setEmailForm({ email: '', current: '' })
    setNotice(`确认链接已发送到 ${accepted.email}，${minutesLeft(accepted.expiresAt)} 内有效。确认之前，当前邮箱继续可用，账号也照常登录。`)
  })

  const startLink = () => void act('link', async () => {
    const started = await api.startGoogleLink('/settings')
    window.location.assign(started.authorizeUrl)
  })

  const submitUnbind = () => void act(`unbind:${unbinding?.id ?? ''}`, async () => {
    if (!unbinding) return
    const result = await api.unbindLoginMethod(unbinding.id, { currentPassword: passwordSet ? unbindPassword : undefined })
    setUnbinding(null); setUnbindPassword('')
    setNotice(`已解绑${methodLabels[result.kind] ?? result.kind}，该方式不能再用它登录。`)
    // 响应自带最新的登录方式列表，直接写进缓存，省一次往返。
    await client.invalidateQueries({ queryKey: ['account-security'] })
  })

  const googleMethod = view?.methods.find(method => method.kind === 'google')
  const strongAuthHint = passwordSet
    ? '这一步需要输入当前密码确认身份。'
    : view?.reauthenticated
      ? '账号没有本地密码，本次操作用最近的 Google 登录完成身份校验。'
      : '账号没有本地密码：请先用 Google 重新登录一次再操作。'

  return <div className="grid gap-6">    <section className="grid gap-3 rounded-xl border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><UserRound aria-hidden className="size-4 text-muted-foreground" />当前账号</h2>
      <dl className="grid gap-1 text-sm">
        <div className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground">账号名</dt><dd className="font-medium">{session.username || '未登录'}</dd></div>
        <div className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground">邮箱</dt><dd>{session.email || '未设置'}</dd></div>
        <div className="flex flex-wrap gap-x-2"><dt className="text-muted-foreground">团队</dt><dd className="break-all">{session.teamId || '尚未创建'}</dd></div>
      </dl>
      <p className="flex gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
        <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-400" />
        登录令牌只存在于 HttpOnly Cookie，页面脚本无法读取；写操作额外校验 CSRF 令牌。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={onOpenConnection}>账号操作</Button>
        <Button disabled={busy !== ''} onClick={() => void act('logout', () => api.logout(), onSignOut)}><LogOut className="size-4" />退出登录</Button>
      </div>
    </section>

    {(error || notice) && <p role={error ? 'alert' : 'status'} className={error
      ? 'rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-200'
      : 'rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-3 text-sm text-emerald-100'}>{error || notice}</p>}

    <section className="grid gap-3 rounded-xl border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><KeyRound aria-hidden className="size-4 text-muted-foreground" />密码</h2>
      {security.isPending ? <p role="status" className="text-sm text-muted-foreground">正在读取账号安全状态…</p>
        : security.error ? <p role="alert" className="text-sm text-red-300">{errorText(security.error)}</p>
          : <>
            <p className="text-sm leading-6 text-muted-foreground">{passwordSet
              ? '修改密码会立刻撤销其它设备上的登录会话与全部访问令牌，当前设备保持登录，不会把人踢出去。'
              : '当前账号没有本地密码，只能用 Google 登录。设置一个密码之后就能用邮箱加密码登录。'}</p>
            <form className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" noValidate onSubmit={event => { event.preventDefault(); if (!busy) submitPassword() }}>
              {passwordSet && <label className="grid gap-1 text-sm font-medium">当前密码
                <Input id="account-password-current" type="password" autoComplete="current-password" value={passwordForm.current} onChange={event => setPasswordForm(form => ({ ...form, current: event.target.value }))} /></label>}
              <label className="grid gap-1 text-sm font-medium">新密码
                <Input id="account-password-next" type="password" autoComplete="new-password" placeholder={`至少 ${minimum} 个字符`} value={passwordForm.next} onChange={event => setPasswordForm(form => ({ ...form, next: event.target.value }))} /></label>
              <label className="grid gap-1 text-sm font-medium">确认新密码
                <Input id="account-password-confirm" type="password" autoComplete="new-password" value={passwordForm.confirm} onChange={event => setPasswordForm(form => ({ ...form, confirm: event.target.value }))} /></label>
              <Button type="submit" className="self-end" disabled={busy !== '' || security.isPending}>{busy === 'password' ? '正在提交…' : passwordSet ? '更新密码' : '设置密码'}</Button>
            </form>
            <p className="text-xs leading-5 text-muted-foreground">{passwordSet ? strongAuthHint : `${strongAuthHint} 新密码至少 ${minimum} 个字符。`}</p>
          </>}
    </section>

    <section className="grid gap-3 rounded-xl border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><Mail aria-hidden className="size-4 text-muted-foreground" />邮箱</h2>
      {security.isPending ? <p role="status" className="text-sm text-muted-foreground">正在读取账号安全状态…</p>
        : security.error ? <p role="alert" className="text-sm text-red-300">{errorText(security.error)}</p>
          : <>
            <p className="text-sm leading-6 text-muted-foreground">当前邮箱 {view?.email || '未设置'}。变更需要点开新邮箱里的确认链接才生效；确认之前旧邮箱继续有效，找回密码也仍然指向旧邮箱。</p>
            {!view?.emailDelivery && <p className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-5 text-amber-100">
              <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />本实例未配置邮件投递（{view?.emailDeliveryReason ?? '原因未知'}），因此改邮箱不可用；请先让实例管理员配置邮件投递。
            </p>}
            <form className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" noValidate onSubmit={event => { event.preventDefault(); if (!busy) submitEmail() }}>
              <label className="grid gap-1 text-sm font-medium">新邮箱
                <Input id="account-email-new" type="email" autoComplete="email" placeholder="new@example.com" value={emailForm.email} onChange={event => setEmailForm(form => ({ ...form, email: event.target.value }))} /></label>
              {passwordSet && <label className="grid gap-1 text-sm font-medium">当前密码
                <Input id="account-email-current" type="password" autoComplete="current-password" value={emailForm.current} onChange={event => setEmailForm(form => ({ ...form, current: event.target.value }))} /></label>}
              <Button type="submit" className="self-end" disabled={busy !== '' || !view?.emailDelivery}>{busy === 'email' ? '正在发送…' : '发送确认链接'}</Button>
            </form>
            <p className="text-xs leading-5 text-muted-foreground">{strongAuthHint} 新旧邮箱都会收到邮件：旧邮箱的提醒是让真正的持箱人有机会阻止变更。</p>
          </>}
    </section>

    <section className="grid gap-3 rounded-xl border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><Link2 aria-hidden className="size-4 text-muted-foreground" />登录方式</h2>
      {security.isPending ? <p role="status" className="text-sm text-muted-foreground">正在读取登录方式…</p>
        : security.error ? <p role="alert" className="text-sm text-red-300">{errorText(security.error)}</p>
          : <>
            <ul className="grid gap-2">
              {(view?.methods ?? []).map(method => <li key={method.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                <Badge variant="secondary">{methodLabels[method.kind] ?? method.kind}</Badge>
                <span className="min-w-0 flex-1 truncate">{method.email ?? method.label}</span>
                {method.createdAt && <span className="text-xs text-muted-foreground">绑定于 {formatChineseTime(method.createdAt)}</span>}
                {method.lastSignInAt && <span className="text-xs text-muted-foreground">最近登录 {formatChineseTime(method.lastSignInAt)}</span>}
                <Button size="sm" variant="ghost" disabled={busy !== '' || !method.removable}
                  onClick={() => { setUnbinding({ id: method.id, kind: method.kind }); setUnbindPassword(''); setError(''); setNotice('') }}>解绑</Button>
              </li>)}
            </ul>
            {(view?.methods.length ?? 0) <= 1 && <p className="text-xs leading-5 text-muted-foreground">这是账号目前唯一的登录方式：先绑定另一种（例如 Google），才能解绑现在这个。</p>}
            {unbinding && <div className="grid gap-2 rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-sm">解绑{methodLabels[unbinding.kind] ?? unbinding.kind}后，该方式不能再用于登录这个账号。</p>
              <div className="flex flex-wrap items-end gap-2">
                {passwordSet && <label className="grid gap-1 text-sm font-medium">当前密码
                  <Input id="account-unbind-password" type="password" autoComplete="current-password" value={unbindPassword} onChange={event => setUnbindPassword(event.target.value)} /></label>}
                <Button variant="destructive" disabled={busy !== ''} onClick={() => void submitUnbind()}>{busy.startsWith('unbind:') ? '正在解绑…' : '确认解绑'}</Button>
                <Button variant="ghost" disabled={busy !== ''} onClick={() => { setUnbinding(null); setUnbindPassword('') }}>取消</Button>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">{strongAuthHint}</p>
            </div>}
            {!googleMethod && <div className="grid gap-2">
              {capabilities.data?.google.enabled
                ? <Button variant="outline" className="justify-self-start" disabled={busy !== ''} onClick={() => void startLink()}>{busy === 'link' ? '正在跳转 Google…' : '绑定 Google 登录'}</Button>
                : <p className="text-xs leading-5 text-muted-foreground">本实例未配置 Google 登录（{capabilities.data?.google.reason ?? '缺少客户端配置'}），无法绑定。</p>}
            </div>}
          </>}
    </section>

    <section className="grid gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><MonitorSmartphone aria-hidden className="size-4 text-muted-foreground" />登录设备与会话</h2>
        <Button size="sm" variant="ghost" className="ml-auto" disabled={sessions.isFetching} onClick={() => void client.invalidateQueries({ queryKey: ['login-sessions'] })}>
          <RefreshCw className={sessions.isFetching ? 'size-4 animate-spin' : 'size-4'} />刷新
        </Button>
      </div>
      {sessions.isPending ? <p role="status" className="text-sm text-muted-foreground">正在读取登录会话…</p>
        : sessions.error ? <p role="alert" className="text-sm text-red-300">{errorText(sessions.error)}</p>
          : (sessions.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">没有活跃的登录会话。</p>
            : <ul className="grid gap-2">{sessions.data!.map(item => <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{item.client || '未知客户端'}</span>
              {item.current && <Badge variant="secondary">当前设备</Badge>}
              <span className="text-xs text-muted-foreground">最近活动 {formatChineseTime(item.lastSeenAt)}</span>
              <span className="text-xs text-muted-foreground">过期 {formatChineseTime(item.idleExpiresAt)}</span>
              <Button size="sm" variant="ghost" disabled={busy !== ''} onClick={() => void act(item.id, async () => {
                await api.revokeLoginSession(item.id)
                if (item.current) onSignOut()
              })}>撤销</Button>
            </li>)}</ul>}
      <div className="flex flex-wrap gap-2">
        <Button variant="destructive" disabled={busy !== ''} onClick={() => void act('logout-all', () => api.logoutAll(), onSignOut)}>退出全部设备</Button>
      </div>
    </section>

    {session.instanceAdministrator && <section className="grid gap-3 rounded-xl border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><Mail aria-hidden className="size-4 text-muted-foreground" />注册与邮件</h2>
      <p className="text-sm leading-6 text-muted-foreground">策略对 API 与页面同时生效：非开放注册时，服务端会直接拒绝新注册，而不只是收起按钮。</p>
      {policy.isPending ? <p role="status" className="text-sm text-muted-foreground">正在读取注册策略…</p>
        : policy.error ? <p role="alert" className="text-sm text-red-300">{errorText(policy.error)}</p>
          : <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={policy.data!.policy === 'open' ? 'success' : 'outline'}>{policyLabels[policy.data!.policy]}</Badge>
              <span className="text-xs text-muted-foreground">{policy.data!.explicit ? '管理员显式设置' : '实例默认值'}{policy.data!.updatedAt ? ` · 更新于 ${formatChineseTime(policy.data!.updatedAt)}` : ''}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {(['open', 'invite_only', 'closed'] as const).map(value => <Button key={value} size="sm" variant={policy.data!.policy === value ? 'default' : 'outline'} disabled={busy !== '' || policy.data!.policy === value}
                onClick={() => void act(`policy:${value}`, () => api.setRegistrationPolicy(value), () => void client.invalidateQueries({ queryKey: ['registration-policy'] }))}>{policyLabels[value]}</Button>)}
            </div>
          </div>}
      <p className="flex gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
        <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-400" />
        {capabilities.data?.registration
          ? capabilities.data.registration.emailDelivery
            ? `邮件投递已配置；验证链接有效期 ${Math.round(capabilities.data.registration.verificationTtlMs / 3600000)} 小时，重置链接 ${Math.round(capabilities.data.registration.resetTtlMs / 60000)} 分钟。`
            : `邮件投递不可用（${capabilities.data.registration.emailDeliveryReason ?? '未配置'}）：开放注册后新用户也收不到验证邮件，页面会如实说明。`
          : '正在读取邮件投递状态…'}
      </p>
    </section>}
  </div>
}