import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, LogOut, Mail, MonitorSmartphone, RefreshCw, ShieldCheck, UserRound } from 'lucide-react'
import type { Api, AccountSession } from '../api/client'
import type { RegistrationPolicyDTO } from '../api/dto'
import { formatChineseTime } from '../lib/display'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : '请求失败'
const policyLabels: Record<RegistrationPolicyDTO, string> = { open: '开放注册', invite_only: '仅邀请', closed: '关闭注册' }

/**
 * 全局设置页里的账号面板（Ticket 04）：只展示可安全披露的会话视图，
 * 登录令牌或其哈希永远不会到达这里。退出与撤销都经由 Cookie 会话 API。
 * Ticket 05 增加实例级注册策略（只对实例管理员显示，非管理员由服务端返回 403）。
 */
export function AccountPage({ api, session, onSignOut, onOpenConnection }: {
  api: Api
  session: AccountSession
  onSignOut: () => void
  onOpenConnection: () => void
}) {
  const client = useQueryClient()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const sessions = useQuery({ queryKey: ['login-sessions'], queryFn: ({ signal }) => api.loginSessions(signal) })
  const policy = useQuery({ queryKey: ['registration-policy'], queryFn: ({ signal }) => api.registrationPolicy(signal), enabled: session.instanceAdministrator })
  const capabilities = useQuery({ queryKey: ['auth-options'], queryFn: ({ signal }) => api.authOptions(signal) })

  const act = async (label: string, run: () => Promise<unknown>, done?: () => void) => {
    setBusy(label); setError('')
    try { await run(); if (done) done(); else await client.invalidateQueries({ queryKey: ['login-sessions'] }) }
    catch (cause) { setError(errorText(cause)) }
    finally { setBusy('') }
  }

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

    <section className="grid gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><MonitorSmartphone aria-hidden className="size-4 text-muted-foreground" />登录设备与会话</h2>
        <Button size="sm" variant="ghost" className="ml-auto" disabled={sessions.isFetching} onClick={() => void client.invalidateQueries({ queryKey: ['login-sessions'] })}>
          <RefreshCw className={sessions.isFetching ? 'size-4 animate-spin' : 'size-4'} />刷新
        </Button>
      </div>
      {error && <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
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