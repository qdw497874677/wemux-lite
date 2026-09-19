import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CircleCheck, MailCheck, ShieldCheck } from 'lucide-react'
import { ApiError, anonymousSession, createApi } from '../api/client'
import type { AccountPayloadDTO } from '../api/dto'
import { Button } from './ui/button'
import { Input } from './ui/input'

const failureText = (cause: unknown): string => {
  if (cause instanceof ApiError) {
    // 400 链接无效 / 409 已使用 / 410 已过期：服务端消息本身就说清了下一步，原样展示。
    if (cause.status === 400 || cause.status === 409 || cause.status === 410) return cause.message.replace(/^请求失败（HTTP \d+）：/, '')
    if (cause.status === 429) return '尝试次数过多，请稍后再试。'
    if (cause.status === 502 || cause.status === 503) return cause.message.replace(/^请求失败（HTTP \d+）：/, '')
    return cause.message
  }
  return cause instanceof Error ? cause.message : '请求失败'
}

/** 从当前地址读取一次性令牌。邮箱扫描器只会 GET 这个页面，不会触发任何写请求。 */
export function readLinkToken(search: string): string {
  try { return new URLSearchParams(search).get('token') ?? '' } catch { return '' }
}

/**
 * 邮箱链接落地页（Ticket 05、Ticket 06）：`/auth/verify-email?token=…`、`/auth/password/reset?token=…`
 * 与 `/auth/confirm-email-change?token=…`。
 * 三个地址必须与 Server 侧的 `WEB_CONSOLE_AUTH_PATHS`（`apps/server/src/application/web-console-routes.ts`）逐个一致：
 * 邮件链接就是从这里发出去的，路径写错就只能落到 API 命名空间的 404 上。
 * 三个页面都不在加载时消费令牌，必须由用户点击按钮才发写请求：
 * 邮件扫描器、预览抓取和安全插件的自动 GET 不会把一次性凭据作废。
 */
export function AuthLinkScreen({ kind, token, onAuthenticated, onGoLogin }: {
  kind: 'verify' | 'reset' | 'change_email'
  token: string
  /** 验证成功即等于登录（服务端同时写入 Cookie 会话）。 */
  onAuthenticated: (account: AccountPayloadDTO) => void
  onGoLogin: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  // 改邮箱的结果要如实回显新旧地址：用户要看到“换成了哪个”，而不是一个笼统的成功。
  const [changed, setChanged] = useState<{ email: string; previousEmail: string | null } | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [minimum, setMinimum] = useState(15)
  const attempt = useRef<{ generation: number; api?: ReturnType<typeof createApi> }>({ generation: 0 })
  const cancel = () => { attempt.current.generation++; attempt.current.api?.dispose(); attempt.current.api = undefined }
  useEffect(() => cancel, [])

  useEffect(() => {
    // 密码长度下限以服务端公开能力为准，避免本地规则与服务端不一致。
    const api = createApi(anonymousSession())
    let active = true
    void api.authOptions().then(options => {
      if (active && options.registration) setMinimum(options.registration.passwordMinimumLength)
    }).catch(() => { /* 取不到就沿用默认值，提交时仍由服务端把关。 */ }).finally(() => api.dispose())
    return () => { active = false; api.dispose() }
  }, [])

  const run = async (action: (api: ReturnType<typeof createApi>) => Promise<void>) => {
    if (busy) return
    cancel()
    const generation = attempt.current.generation
    const api = createApi(anonymousSession())
    attempt.current.api = api
    setBusy(true); setError('')
    try { await action(api) } catch (cause) {
      if (attempt.current.generation === generation) setError(failureText(cause))
    } finally { api.dispose(); if (attempt.current.generation === generation) setBusy(false) }
  }

  const confirmVerify = () => void run(async api => {
    onAuthenticated(await api.verifyEmail(token))
  })

  const submitReset = () => void run(async api => {
    if (password.length < minimum) throw new Error(`密码至少需要 ${minimum} 个字符。`)
    if (password !== confirm) throw new Error('两次输入的密码不一致。')
    await api.resetPassword(token, password)
    setPassword(''); setConfirm('')
    setDone(true)
  })

  // 确认链接可能在没有登录态的浏览器里打开（链接本身就是凭证）；已登录时也不影响现有会话。
  const confirmChangeEmail = () => void run(async api => {
    const result = await api.confirmEmailChange(token)
    setChanged({ email: result.email, previousEmail: result.previousEmail })
  })

  const heading = kind === 'verify' ? '确认邮箱并激活账号' : kind === 'reset' ? '设置新密码' : '确认更换邮箱'
  const missing = token.length === 0
  return <main className="landing-root grain-overlay" aria-labelledby="link-title">
    <section className="landing-card">
      <p className="flex items-center gap-3"><span aria-hidden className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-lg font-black text-white shadow-[0_2px_12px_hsl(244_75%_64%_/.3)]">W</span><strong className="text-base tracking-tight">Wemux Lite</strong></p>
      <h1 id="link-title" className="text-lg font-semibold">{heading}</h1>

      {missing ? <>
        <p role="alert" className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-sm leading-6 text-amber-100"><AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />这个链接缺少令牌。请使用邮件里的完整链接，或重新发起一次。</p>
        <Button className="h-10 w-full text-sm" onClick={onGoLogin}>返回登录</Button>
      </> : done || changed ? <>
        <p role="status" className="flex gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-3 text-sm leading-6 text-emerald-100"><CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" />{changed
          ? `账号邮箱已更换为 ${changed.email}${changed.previousEmail ? `（原 ${changed.previousEmail}）` : ''}。之后请用新邮箱登录、找回密码；旧邮箱不再能用于找回。`
          : '密码已重置，所有旧会话已被撤销。请用新密码重新登录。'}</p>
        <Button className="h-10 w-full text-sm" onClick={onGoLogin}>{kind === 'change_email' ? '返回 Wemux' : '去登录'}</Button>
      </> : <>
        <p className="text-sm leading-6 text-muted-foreground">
          {kind === 'verify'
            ? '点击下面的按钮完成邮箱验证。链接只能使用一次；本页面在加载时不会消耗它，因此邮件扫描器或预览抓取不会让链接失效。'
            : kind === 'reset'
              ? `重置会撤销该账号的全部登录会话。新密码至少 ${minimum} 个字符。链接只能使用一次。`
              : '点击下面的按钮把账号邮箱换成邮件里的新地址。链接只能使用一次；本页面在加载时不会消耗它，因此邮件扫描器或预览抓取不会让链接失效。'}
        </p>
        {error && <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
        {kind === 'verify' ? <Button className="press-feedback h-10 w-full text-sm font-semibold" disabled={busy} onClick={confirmVerify}>
          <MailCheck aria-hidden className="size-4" />{busy ? '正在验证…' : '确认并激活账号'}
        </Button> : kind === 'change_email' ? <Button className="press-feedback h-10 w-full text-sm font-semibold" disabled={busy} onClick={confirmChangeEmail}>
          <MailCheck aria-hidden className="size-4" />{busy ? '正在更换…' : '确认更换邮箱'}
        </Button> : <>
          <label htmlFor="link-password" className="text-sm font-medium">新密码</label>
          <Input id="link-password" type="password" value={password} placeholder={`至少 ${minimum} 个字符`} autoComplete="new-password"
            onChange={event => { setPassword(event.target.value); setError('') }} />
          <label htmlFor="link-confirm" className="text-sm font-medium">确认新密码</label>
          <Input id="link-confirm" type="password" value={confirm} placeholder="再次输入新密码" autoComplete="new-password"
            onChange={event => { setConfirm(event.target.value); setError('') }} />
          <Button className="press-feedback h-10 w-full text-sm font-semibold" disabled={busy} onClick={submitReset}>{busy ? '正在提交…' : '设置新密码'}</Button>
        </>}
        <button type="button" className="text-xs text-muted-foreground underline decoration-dotted underline-offset-4" onClick={onGoLogin}>返回登录</button>
      </>}
      <p className="flex gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground"><ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-400" /><span>令牌只用于这一次请求，随后立即失效；它不会保存在浏览器存储或 Cookie 里。</span></p>
    </section>
  </main>
}