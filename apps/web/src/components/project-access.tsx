import { useEffect, useState } from 'react'
import { ShieldCheck, UserPlus } from 'lucide-react'
import type { ProjectDTO } from '../api/dto.ts'
import type { ReturnTypeOfCreateApi } from '../api/team-types.ts'
import { Button } from './ui/button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.tsx'

export function ProjectAccessPanel({ api, project, onChanged }: { api: ReturnTypeOfCreateApi; project: ProjectDTO; onChanged: () => void }) {
  const [members, setMembers] = useState<Awaited<ReturnType<typeof api.teamMembers>>>([])
  const [grants, setGrants] = useState<Awaited<ReturnType<typeof api.projectGrants>>>([])
  const [userId, setUserId] = useState(''), [role, setRole] = useState<'viewer' | 'contributor' | 'manager'>('viewer')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const canManage = project.accessRole === 'owner' || project.accessRole === 'manager'
  const load = async () => { if (!canManage) return; const [nextMembers, nextGrants] = await Promise.all([api.teamMembers(project.teamId), api.projectGrants(project.id)]); setMembers(nextMembers); setGrants(nextGrants) }
  useEffect(() => { void load().catch(cause => setError(cause instanceof Error ? cause.message : '读取项目权限失败')) }, [api, project.id, project.teamId, canManage])
  if (!canManage) return <p className="rounded-xl border border-border bg-muted/20 p-4 text-sm text-muted-foreground">你拥有 {project.accessRole} 权限。只有 owner 或 manager 可以管理共享范围。</p>
  const grantable = members.filter(member => member.user.id !== project.ownerId)
  const saveScope = async (shareScope: ProjectDTO['shareScope']) => { setBusy(true); setError(''); try { await api.updateProjectAccess(project.id, shareScope); onChanged() } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败') } finally { setBusy(false) } }
  const saveGrant = async () => { if (!userId) return; setBusy(true); setError(''); try { await api.grantProject(project.id, userId, role); await load() } catch (cause) { setError(cause instanceof Error ? cause.message : '授权失败') } finally { setBusy(false) } }
  return <section className="grid gap-4 rounded-2xl border bg-card p-5" aria-labelledby="project-access-title">
    <div><h2 id="project-access-title" className="flex items-center gap-2 font-semibold"><ShieldCheck className="size-4" />项目访问</h2><p className="mt-1 text-sm text-muted-foreground">共享范围决定默认可见性；成员 Grant 可赋予更高的项目角色。</p></div>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    <label className="grid gap-2 text-sm"><span>共享范围</span><Select value={project.shareScope} disabled={busy} onValueChange={value => void saveScope(value as ProjectDTO['shareScope'])}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="owner-only">仅 owner</SelectItem><SelectItem value="selected-members">指定成员</SelectItem><SelectItem value="team">Team 全员只读</SelectItem></SelectContent></Select></label>
    <div className="grid gap-2"><h3 className="text-sm font-medium">成员 Grant</h3><div className="grid gap-2 sm:grid-cols-[1fr_11rem_auto]"><Select value={userId} onValueChange={setUserId}><SelectTrigger><SelectValue placeholder="选择团队成员" /></SelectTrigger><SelectContent>{grantable.map(member => <SelectItem key={member.user.id} value={member.user.id}>{member.user.username}</SelectItem>)}</SelectContent></Select><Select value={role} onValueChange={value => setRole(value as typeof role)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="viewer">viewer</SelectItem><SelectItem value="contributor">contributor</SelectItem><SelectItem value="manager">manager</SelectItem></SelectContent></Select><Button disabled={busy || !userId} onClick={() => void saveGrant()}><UserPlus className="size-4" />授权</Button></div>
      <div className="grid gap-2">{grants.map(grant => { const member = members.find(value => value.user.id === grant.userId); return <div key={grant.userId} className="flex items-center justify-between rounded-xl border px-3 py-2 text-sm"><span>{member?.user.username ?? grant.userId}</span><span className="flex items-center gap-2 text-muted-foreground">{grant.role}<Button size="sm" variant="ghost" onClick={() => void api.revokeProjectGrant(project.id, grant.userId).then(load)}>移除</Button></span></div> })}</div>
    </div>
  </section>
}
