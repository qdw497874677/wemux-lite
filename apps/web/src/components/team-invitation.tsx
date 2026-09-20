import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, LoaderCircle, Mail, Users } from 'lucide-react'
import { anonymousSession, createApi, type AccountSession } from '../api/client.ts'
import type { AccountPayloadDTO, AuthOptionsDTO } from '../api/dto.ts'
import { AuthForm } from './auth-form.tsx'
import { Button } from './ui/button.tsx'

interface InvitationView {
  readonly team: { id: string; name: string }
  readonly email: string
  readonly role: 'admin' | 'member'
  readonly status: 'pending' | 'accepted' | 'expired' | 'revoked'
}

export function TeamInvitationScreen({ token, session, onAuthenticated }: { token: string; session: AccountSession | null; onAuthenticated: (account: AccountPayloadDTO) => void }) {
  const [invitation, setInvitation] = useState<InvitationView | null>(null)
  const [capabilities, setCapabilities] = useState<AuthOptionsDTO | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [accepted, setAccepted] = useState(false)
  useEffect(() => {
    const api = createApi(anonymousSession())
    void Promise.all([api.invitation(token), api.authOptions()]).then(([value, auth]) => { setInvitation(value); setCapabilities(auth) }).catch(cause => setError(cause instanceof Error ? cause.message : '无法读取邀请')).finally(() => api.dispose())
    return () => api.dispose()
  }, [token])
  const accept = useCallback(async () => {
    if (!session) return
    setPending(true); setError('')
    const api = createApi(session)
    try { await api.acceptInvitation(token); setAccepted(true) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '接受邀请失败') }
    finally { setPending(false); api.dispose() }
  }, [session, token])
  useEffect(() => { if (session && invitation?.status === 'pending') void accept() }, [accept, session, invitation?.status])
  return <main className="landing-root grain-overlay">
    <section className="mx-auto grid w-full max-w-lg gap-6 rounded-2xl border bg-card p-6 shadow-xl sm:p-8" aria-labelledby="invitation-title">
      <div className="grid gap-3 text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary"><Users className="size-6" /></span>
        <p className="text-xs font-semibold uppercase tracking-[.18em] text-muted-foreground">团队邀请</p>
        <h1 id="invitation-title" className="text-2xl font-semibold">{invitation?.team.name ?? '正在读取邀请…'}</h1>
        {invitation && <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><Mail className="size-4" />仅限 {invitation.email}</p>}
      </div>
      {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</p>}
      {accepted ? <div className="grid gap-4 text-center"><CheckCircle2 className="mx-auto size-8 text-emerald-500" /><p>已加入团队，可以进入控制台开始协作。</p><Button onClick={() => { window.location.href = '/projects' }}>进入控制台</Button></div>
        : invitation?.status !== 'pending' ? invitation && <p className="text-center text-sm text-muted-foreground">该邀请已{invitation.status === 'accepted' ? '使用' : invitation.status === 'expired' ? '过期' : '撤销'}。</p>
          : session ? <div className="grid gap-3"><p className="text-sm text-muted-foreground">当前登录账号必须使用邀请邮箱。确认后会立即成为团队成员。</p><Button disabled={pending} onClick={() => void accept()}>{pending && <LoaderCircle className="size-4 animate-spin" />}接受邀请</Button></div>
            : <div className="grid gap-5"><p className="text-sm text-muted-foreground">已有账号请登录；没有账号可直接注册，邮箱已锁定为邀请目标。</p><AuthForm mode="login" minimumLength={capabilities?.passwordMinimumLength ?? 15} capabilities={capabilities?.registration ?? null} google={capabilities?.google ?? null} submitLabel="登录后接受" onAuthenticated={account => { onAuthenticated(account); window.location.href = `/join?token=${encodeURIComponent(token)}` }} /><div className="border-t pt-5"><AuthForm mode="register" minimumLength={capabilities?.passwordMinimumLength ?? 15} capabilities={capabilities?.registration ? { ...capabilities.registration, registrationPolicy: 'open' } : null} google={null} submitLabel="注册并加入" invitation={{ email: invitation.email, token }} onAuthenticated={onAuthenticated} /></div></div>}
    </section>
  </main>
}
