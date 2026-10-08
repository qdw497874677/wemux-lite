import { PublicAccountOptions } from './PublicAccount.tsx'
import { PaperclipNotice } from './PaperclipNotice.tsx'
import { useEffect, useState } from 'react'
import { Network, ShieldCheck } from 'lucide-react'
import type { Application, AppState } from '../application.ts'
import { Button, Input } from './primitives.tsx'
import { Failure } from './Failure.tsx'

export function Login({ app, state }: { app: Application; state: AppState }) {
  const [login, setLogin] = useState(''), [password, setPassword] = useState('')
  useEffect(() => {
    if (!login && !password) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [login, password])
  return <main className="landing">
    <section className="landing-intro"><a href="/" className="brand"><Network aria-hidden />Wemux Lite</a><span className="eyebrow">新版控制台</span><h1>从项目开始，<br />让协作有据可循。</h1><p>同一个实例，同一套账号与项目。集中查看你有权访问的工作，再进入具体的执行环境。</p><p className="muted">新版正在逐步迁移。其余功能仍可在旧版使用。</p><a href="/">打开旧版控制台</a></section>
    <section className="login-panel" aria-labelledby="login-title"><h2 id="login-title">登录控制台</h2><p className="muted">使用当前实例的账号，无需重新注册。</p><p className="host-address">{window.location.origin}</p>
      {state.notice && <p role="status">{state.notice}</p>}{state.error && <Failure error={state.error} />}
      {!window.isSecureContext && <p className="http-notice">当前使用 HTTP。登录信息会经过未加密网络，请仅在可信网络使用，公网请配置 HTTPS。</p>}
      <form onSubmit={event => { event.preventDefault(); const value = password; setPassword(''); void app.login(login, value) }}>
        <label htmlFor="login">邮箱或用户名</label><Input id="login" name="username" autoComplete="username" autoFocus required value={login} onChange={event => setLogin(event.target.value)} />
        <label htmlFor="password">密码</label><Input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} />
        <Button type="submit" disabled={state.busy}>{state.busy ? '正在登录…' : '登录'}</Button>
      </form><p className="muted security-note"><ShieldCheck aria-hidden />会话由当前宿主的安全 Cookie 管理。</p><PublicAccountOptions />
    <PaperclipNotice /></section></main>
}
