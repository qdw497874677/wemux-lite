import { useEffect, useMemo, useState } from 'react'
import { createClusterClient } from '@wemux/web-client'
import type { Application } from '../application.ts'
import { safeReturnTarget } from '../application.ts'
import { navigate } from '../lib/navigation.ts'
import { readOauthError, withoutOauthError } from '../lib/oauth-error.ts'
import { ActionForm, useAccountData, useAction } from './AccountForms.tsx'
import { Button } from './primitives.tsx'

export function PublicAccountOptions() {
  const api = useMemo(() => createClusterClient(), [])
  useEffect(() => () => api.dispose(), [api])
  const options = useAccountData(() => api.authOptions(), [api])
  const action = useAction()
  const [mode, setMode] = useState<'register' | 'forgot' | 'resend' | null>(null)
  const [oauthError] = useState(() => readOauthError(window.location.search))
  useEffect(() => {
    if (!oauthError) return
    window.history.replaceState(window.history.state, '', `${withoutOauthError(window.location.pathname, window.location.search)}${window.location.hash}`)
    window.dispatchEvent(new Event('wemux:navigate'))
  }, [oauthError])
  const registration = options.data?.registration
  const token = new URLSearchParams(window.location.search).get('token') ?? new URLSearchParams(new URLSearchParams(window.location.search).get('returnTo')?.split('?')[1]).get('token') ?? undefined
  return <div className="public-account">{oauthError && <p role="alert">{oauthError}</p>}{options.feedback}
    {options.data && <><p>{!registration?.emailDelivery && (registration?.emailDeliveryReason ?? '当前宿主不支持邮件自助流程。')}</p><div className="account-actions">{(['register', 'forgot', 'resend'] as const).map(value => <Button key={value} variant="outline" onClick={() => setMode(value)}>{value === 'register' ? '注册账号' : value === 'forgot' ? '找回密码' : '重发验证邮件'}</Button>)}</div>
      {mode && <ActionForm key={mode} disabled={!registration?.emailDelivery || (mode === 'register' && registration.registrationPolicy === 'closed')} label={mode === 'register' ? '发送注册验证邮件' : mode === 'forgot' ? '发送重置邮件' : '重发验证邮件'} fields={[{ name: 'email', label: '邮箱', type: 'email' }, ...(mode === 'register' ? [{ name: 'displayName', label: '显示名称' }, { name: 'password', label: '注册密码', type: 'password', minLength: registration?.passwordMinimumLength ?? 15 }, { name: 'invitationToken', label: '邀请令牌（仅邀请注册时必填）', required: false, value: token }] : [])]} submit={async values => {
        if (mode === 'register') await api.register({ email: values.email!, displayName: values.displayName!, password: values.password!, invitationToken: values.invitationToken || undefined })
        else if (mode === 'forgot') await api.forgotPassword(values.email!)
        else await api.resendVerification(values.email!)
        return '请求已受理。如符合条件，请检查邮箱并使用邮件中的新版链接。'
      }}><p>注册策略：{registration?.registrationPolicy === 'closed' ? '关闭注册' : registration?.registrationPolicy === 'invite_only' ? '仅邀请' : '开放注册'}</p></ActionForm>}
      <Button variant="outline" disabled={!options.data.google.enabled || action.busy} onClick={() => void action.run(async () => { const result = await api.startGoogleSignIn(safeReturnTarget(new URLSearchParams(window.location.search).get('returnTo') ?? `${window.location.pathname}${window.location.search}`)); window.location.assign(result.authorizeUrl) })}>使用 Google 登录</Button>{!options.data.google.enabled && <p>{options.data.google.reason}</p>}{action.feedback}</>}
  </div>
}

/** GET only displays a confirmation. Mail scanners never consume the token. */
export function AccountLink({ app, path, search }: { app: Application; path: string; search: string }) {
  const api = useMemo(() => createClusterClient(), [])
  useEffect(() => () => api.dispose(), [api])
  const token = new URLSearchParams(search).get('token') ?? ''
  const [done, setDone] = useState('')
  const reset = path.endsWith('/password/reset'), verify = path.endsWith('/verify-email')
  return <main className="recovery"><h1>{reset ? '重置密码' : verify ? '验证邮箱' : '确认更换邮箱'}</h1><p>链接只能按原用途使用。点击确认后才会提交，不会自动消费令牌。</p>{!token && <p role="alert">链接缺少令牌，请使用邮件里的完整链接。</p>}
    {!done && <ActionForm disabled={!token} label={reset ? '设置新密码' : verify ? '确认并激活账号' : '确认更换邮箱'} fields={reset ? [{ name: 'password', label: '新密码', type: 'password' }, { name: 'confirm', label: '确认新密码', type: 'password' }] : []} submit={async values => {
      if (reset) { if (values.password !== values.confirm) throw Error('两次输入的新密码不一致。'); await api.resetPassword(token, values.password!); setDone('密码已重置，全部旧会话已撤销，请重新登录。') }
      else if (verify) { await api.verifyEmail(token); window.history.replaceState(null, '', '/next/projects'); await app.start(); navigate('/next/projects', true) }
      else { const result = await api.confirmEmailChange(token); setDone(`邮箱已更换为 ${result.email}，请重新登录。`) }
    }} />}{done && <p role="status">操作已完成。{done}</p>}<a href="/next/login">返回登录</a></main>
}
