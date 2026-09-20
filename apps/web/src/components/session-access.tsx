import { useEffect, useState } from 'react'
import { ShieldCheck, UserPlus } from 'lucide-react'
import type { ProjectDTO, SessionDTO } from '../api/dto.ts'
import type { ReturnTypeOfCreateApi } from '../api/team-types.ts'
import { Button } from './ui/button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.tsx'

const scopeLabel: Record<NonNullable<SessionDTO['shareScope']>, string> = {
  'owner-only': '仅会话 owner',
  'selected-members': '指定项目成员',
  project: '项目成员',
}

export function SessionAccessPanel({ api, session, project, onChanged }: { api: ReturnTypeOfCreateApi; session: SessionDTO; project: ProjectDTO; onChanged: () => void }) {
  const [members, setMembers] = useState<Awaited<ReturnType<typeof api.teamMembers>>>([])
  const [grants, setGrants] = useState<Awaited<ReturnType<typeof api.sessionGrants>>>([])
  const [userId, setUserId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const canControl = session.access?.canControl === true
  const canGrant = session.access?.projectRole === 'owner' || session.access?.projectRole === 'manager'
  const scope = session.shareScope ?? 'owner-only'

  const load = async () => {
    if (!canControl) return
    const [nextMembers, nextGrants] = await Promise.all([api.teamMembers(project.teamId), api.sessionGrants(session.id)])
    setMembers(nextMembers)
    setGrants(nextGrants)
  }
  useEffect(() => { void load().catch(cause => setError(cause instanceof Error ? cause.message : '读取会话权限失败')) }, [api, canControl, project.teamId, session.id])

  const saveScope = async (shareScope: NonNullable<SessionDTO['shareScope']>) => {
    setBusy(true); setError('')
    try { await api.updateSessionAccess(session.id, shareScope); onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存共享范围失败') }
    finally { setBusy(false) }
  }
  const saveGrant = async () => {
    if (!userId) return
    setBusy(true); setError('')
    try { await api.grantSession(session.id, userId); setUserId(''); await load(); onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '授权失败') }
    finally { setBusy(false) }
  }
  const revoke = async (targetUserId: string) => {
    setBusy(true); setError('')
    try { await api.revokeSessionGrant(session.id, targetUserId); await load(); onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '撤销授权失败') }
    finally { setBusy(false) }
  }

  const candidates = members.filter(member => member.user.id !== session.ownerId && !grants.some(grant => grant.userId === member.user.id))
  return <div className="grid gap-3 text-xs">
    <div className="flex items-center gap-2 text-foreground/80"><ShieldCheck className="size-3.5" /><strong>会话访问</strong></div>
    <p className="leading-5 text-muted-foreground">读取、发送和控制是独立权限。共享会话不会自动共享工作区文件。</p>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-destructive">{error}</p>}
    {canControl ? <label className="grid gap-1.5"><span className="text-muted-foreground">共享范围</span><Select value={scope} disabled={busy} onValueChange={value => void saveScope(value as NonNullable<SessionDTO['shareScope']>)}><SelectTrigger className="h-8"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="owner-only">仅会话 owner</SelectItem><SelectItem value="selected-members">指定项目成员</SelectItem><SelectItem value="project">项目成员</SelectItem></SelectContent></Select></label> : <p className="rounded-lg border border-border/40 bg-muted/20 p-2 text-muted-foreground">共享范围：{scopeLabel[scope]}。当前账号不能修改。</p>}
    {canControl && scope === 'selected-members' && <div className="grid gap-2">
      <span className="text-muted-foreground">指定成员</span>
      {canGrant ? <div className="flex gap-2"><Select value={userId} onValueChange={setUserId}><SelectTrigger className="h-8 min-w-0 flex-1"><SelectValue placeholder="选择项目成员" /></SelectTrigger><SelectContent>{candidates.map(member => <SelectItem key={member.user.id} value={member.user.id}>{member.user.username}</SelectItem>)}</SelectContent></Select><Button size="sm" className="h-8" disabled={busy || !userId} onClick={() => void saveGrant()}><UserPlus className="size-3.5" />授权</Button></div> : <p className="text-muted-foreground">只有 Project owner 或 manager 可以添加指定成员。</p>}
      <div className="grid gap-1.5">{grants.map(grant => { const member = members.find(value => value.user.id === grant.userId); return <div key={grant.userId} className="flex items-center justify-between gap-2 rounded-lg border border-border/40 px-2 py-1.5"><span className="truncate">{member?.user.username ?? grant.userId}</span>{canGrant && <Button size="sm" variant="ghost" className="h-7 px-2" disabled={busy} onClick={() => void revoke(grant.userId)}>移除</Button>}</div> })}{grants.length === 0 && <p className="text-muted-foreground">尚未授权成员。</p>}</div>
    </div>}
    <p className="text-[10px] leading-4 text-muted-foreground/70">你的项目角色：{session.access?.projectRole ?? '未知'}；{session.access?.canWrite ? '可发送消息' : '仅查看'}；{session.access?.canControl ? '可控制会话' : '不可干预他人执行'}。</p>
  </div>
}
