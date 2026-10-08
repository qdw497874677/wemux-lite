import { useEffect, useState } from 'react'
import type { createClusterClient } from '@wemux/web-client'
import { AccountSection, ActionForm, ConfirmButton, useAccountData, useAction } from './AccountForms.tsx'
import { Button } from './primitives.tsx'
import { readLinkError, readLinkNotice, withoutLinkParams } from '../lib/oauth-error.ts'
export type AccountApi = ReturnType<typeof createClusterClient>
export function AccountSecurity({ api, restart }: { api: AccountApi; restart: () => Promise<void> }) {
  const data = useAccountData(async () => ({ security: await api.accountSecurity(), options: await api.authOptions() }), [api])
  const action = useAction()
  useEffect(() => {
    const check = () => { void api.currentAccount().catch(() => { /* Transport clears an expired identity; transient failures keep the page usable. */ }) }
    const timer = window.setInterval(check, 15000)
    window.addEventListener('focus', check)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', check) }
  }, [api])
  const [notice] = useState(() => readLinkNotice(window.location.search)), [error] = useState(() => readLinkError(window.location.search))
  useEffect(() => { if (notice || error) window.history.replaceState(null, '', withoutLinkParams(window.location.pathname, window.location.search)) }, [notice, error])
  const view = data.data?.security
  return <AccountSection title="账号安全">{data.feedback}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}{view && <><p>当前邮箱：{view.email ?? '未设置'}</p>
    <ActionForm label={view.passwordSet ? '修改密码' : '设置密码'} fields={[...(view.passwordSet ? [{ name: 'currentPassword', label: '当前密码', type: 'password' }] : []), { name: 'newPassword', label: '新密码', type: 'password', minLength: data.data?.options.passwordMinimumLength }, { name: 'confirm', label: '确认新密码', type: 'password' }]} submit={async values => {
      if (values.newPassword !== values.confirm) throw Error('两次输入的新密码不一致。')
      const result = await api.changePassword({ currentPassword: values.currentPassword, newPassword: values.newPassword! }); data.reload()
      return `密码已更新，其他 ${result.revokedSessions} 个会话及 ${result.revokedTokens} 个访问凭据已撤销。`
    }} />
    {!view.emailDelivery && <p>{view.emailDeliveryReason}</p>}
    <ActionForm label="申请更换邮箱" disabled={!view.emailDelivery} fields={[{ name: 'newEmail', label: '新邮箱', type: 'email' }, ...(view.passwordSet ? [{ name: 'currentPassword', label: '当前密码', type: 'password' }] : [])]} submit={async values => { await api.requestEmailChange({ newEmail: values.newEmail!, currentPassword: values.currentPassword }); return '确认邮件已发送至新邮箱。确认前邮箱不变。' }} />
    <h3>登录方式</h3>{view.methods.map(method => <div className="account-row" key={method.id}><p>{method.label} {method.email} {!method.removable && '（最后一种登录方式，不可移除）'}</p>{method.removable && <ActionForm label={`解绑 ${method.label}`} confirm="确认移除此登录方式？其他会话和访问凭据可能被撤销。" fields={view.passwordSet ? [{ name: 'currentPassword', label: '当前密码', type: 'password' }] : []} submit={async values => { await api.unbindLoginMethod(method.id, { currentPassword: values.currentPassword }); data.reload(); return '登录方式已解绑。' }} />}</div>)}
    <Button disabled={!data.data?.options.google.enabled || action.busy} onClick={() => void action.run(async () => { const result = await api.startGoogleLink('/next/settings'); window.location.assign(result.authorizeUrl) })}>绑定 Google 登录</Button>{!data.data?.options.google.enabled && <p>{data.data?.options.google.reason}</p>}{action.feedback}
    <LoginSessions api={api} restart={restart} />
  </>}</AccountSection>
}
function LoginSessions({ api, restart }: { api: AccountApi; restart: () => Promise<void> }) {
  const sessions = useAccountData(() => api.loginSessions(), [api])
  return <><h3>登录会话</h3>{sessions.feedback}{sessions.data?.map(session => <div className="account-row" key={session.id}><p>{session.current ? '当前设备' : '其他设备'}：{session.client || '未知客户端'}<br />最近访问：{new Date(session.lastSeenAt).toLocaleString('zh-CN')}{session.revokedAt && '（已撤销）'}</p><ConfirmButton disabled={!!session.revokedAt} confirm={session.current ? '撤销当前会话并退出？' : '撤销此设备的登录？'} act={async () => { await api.revokeLoginSession(session.id); if (session.current) await restart(); else sessions.reload() }}>撤销会话</ConfirmButton></div>)}<ConfirmButton confirm="撤销其他设备的登录会话？当前设备保持登录。" act={async () => { const result = await api.logoutAll(); sessions.reload(); return `已撤销其他 ${result.revoked} 个会话，当前设备仍保持登录。` }}>退出其他设备</ConfirmButton></>
}
