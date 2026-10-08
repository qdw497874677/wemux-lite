import { useRef, useState } from 'react'
import { copyText, selectElementText } from '@wemux/web-client'
import type { PersonalAccessTokenScopeDTO } from '@wemux/web-contract/browser-host'
import type { AccountApi } from './AccountSecurity.tsx'
import { AccountSection, ActionForm, ConfirmButton, useAccountData } from './AccountForms.tsx'
import { Button } from './primitives.tsx'
export function AccountCredentials({ api }: { api: AccountApi }) {
  const tokens = useAccountData(() => api.personalAccessTokens(), [api])
  const [issued, setIssued] = useState(''), [notice, setNotice] = useState('')
  const [scopes, setScopes] = useState<PersonalAccessTokenScopeDTO[]>(['read'])
  const secret = useRef<HTMLElement>(null)
  const expires = (days: string) => { const value = Number(days); if (!Number.isFinite(value) || value <= 0 || value > 365) throw Error('有效期须为 1 至 365 天。'); return new Date(Date.now() + value * 86400000).toISOString() }
  return <AccountSection title="访问凭据">{tokens.feedback}<p>凭据仅在创建或轮换成功时显示一次，离开此页后不再显示。请保存在安全位置。</p>
    {issued && <div className="secret-once"><code ref={secret}>{issued}</code><Button onClick={() => void copyText(issued).then(ok => { if (!ok && secret.current) selectElementText(secret.current); setNotice(ok ? '已复制' : '已选中文本，请按 Ctrl+C 或长按复制。') })}>复制凭据</Button><Button variant="outline" onClick={() => { setIssued(''); setNotice('') }}>隐藏凭据</Button><p role="status">{notice}</p></div>}
    <ActionForm label="创建访问凭据" fields={[{ name: 'name', label: '凭据名称' }, { name: 'days', label: '有效天数', type: 'number', value: '30' }]} submit={async values => { setIssued(''); const token = await api.createPersonalAccessToken({ name: values.name!, scopes, expiresAt: expires(values.days!) }); setIssued(token.token); tokens.reload(); return '凭据已创建。' }}><div className="account-actions" role="group" aria-label="权限范围">{(['read', 'write', 'execute', 'admin'] as const).map(scope => <label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={event => setScopes(current => event.target.checked ? [...current, scope] : current.filter(value => value !== scope))} />{({ read: '读取', write: '写入', execute: '执行', admin: '管理' })[scope]}</label>)}</div></ActionForm>
    {tokens.data?.map(token => <div className="account-row" key={token.id}><p>{token.name}（{token.scopes.join(' / ')}）<br />到期：{new Date(token.expiresAt).toLocaleString('zh-CN')} {token.revokedAt && '已撤销'}</p>{!token.revokedAt && <><ActionForm label={`轮换 ${token.name}`} confirm="旧凭据立即失效。确认轮换？" fields={[{ name: 'days', label: '新有效天数', type: 'number', value: '30' }]} submit={async values => { setIssued(''); const next = await api.rotatePersonalAccessToken(token.id, expires(values.days!)); setIssued(next.token); tokens.reload(); return '旧凭据已失效，请保存新凭据。' }} /><ConfirmButton confirm="立即撤销此访问凭据？" act={async () => { await api.revokePersonalAccessToken(token.id); setIssued(''); tokens.reload(); return '已撤销。' }}>撤销凭据</ConfirmButton></>}</div>)}
  </AccountSection>
}
