import { useEffect, useState } from 'react'
import { AlertTriangle, LogOut, ShieldCheck, UserRound } from 'lucide-react'
import { anonymousSession, createApi, isSignedIn, type AccountSession } from '../api/client'
import type { AccountPayloadDTO, AuthOptionsDTO } from '../api/dto'
import { AuthForm, toAccountSession } from './auth-form'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'

/**
 * 应用内账号弹窗：登录过期后重新登录，或查看当前账号并退出。
 * 首屏认证仍走 `landing.tsx` 的内联表单，这里只处理已经进入控制台之后的会话变化。
 */
export function ConnectionDialog({ session, expired, onClose, onSignedIn, onSignOut }: {
  session: AccountSession
  expired?: boolean
  onClose: () => void
  onSignedIn: (account: AccountPayloadDTO) => void
  onSignOut: () => void
}) {
  const signedIn = isSignedIn(session)
  const [switching, setSwitching] = useState(!signedIn)
  const [options, setOptions] = useState<AuthOptionsDTO | null>(null)
  const plainHttp = window.location.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
  const showForm = switching || !signedIn
  // 弹窗内的重新登录也要能用 Google：纯 Google 账号没有本地密码，只给密码表单会把人困住。
  // 拿不到能力清单时按未配置处理，宁可不显示按钮也不发一个必败的请求。
  useEffect(() => {
    if (!showForm) return
    const api = createApi(anonymousSession())
    let active = true
    void api.authOptions().then(value => { if (active) setOptions(value) }).catch(() => { if (active) setOptions(null) }).finally(() => api.dispose())
    return () => { active = false; api.dispose() }
  }, [showForm])

  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="max-w-lg">
    <DialogHeader><div className="flex items-center gap-3">
      <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary"><UserRound className="size-5" /></span>
      <div>
        <DialogTitle>{showForm ? '登录 Wemux Lite' : '账号'}</DialogTitle>
        <DialogDescription className="mt-1">{showForm ? '使用管理员账号登录；会话保存在 HttpOnly Cookie 中。' : '当前登录的账号与退出方式。'}</DialogDescription>
      </div>
    </div></DialogHeader>
    <div className="grid gap-5 p-6">
      <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">服务端地址：<strong className="break-all text-foreground">{window.location.origin}</strong></p>
      {!showForm && <p className="text-sm">已登录为 <strong>{session.username}</strong>{session.email ? `（${session.email}）` : ''}。</p>}
      {expired && showForm && <p role="status" className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-5 text-amber-100">登录会话已失效，请重新登录后继续。此前的页面状态会在登录成功后保留。</p>}
      {showForm && <AuthForm mode="login" google={options?.google} submitLabel="登录" onAuthenticated={onSignedIn} />}
      <p className="flex gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground"><ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-400" /><span>登录令牌不落盘、不暴露给页面脚本；写操作额外校验 CSRF 令牌。</span></p>
      {plainHttp && <p className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-5 text-amber-100"><AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />当前为 HTTP 明文连接，账号密码可能被同一网络中的其他设备看到，仅建议用于可信内网或本机。</p>}
    </div>
    <DialogFooter>
      {signedIn && !switching && <Button variant="outline" onClick={() => setSwitching(true)}>切换账号</Button>}
      {signedIn && <Button variant="destructive" onClick={onSignOut}><LogOut className="size-4" />退出登录</Button>}
      <Button variant={signedIn ? 'ghost' : 'outline'} onClick={onClose}>{signedIn ? '关闭' : '稍后再说'}</Button>
    </DialogFooter>
  </DialogContent></Dialog>
}