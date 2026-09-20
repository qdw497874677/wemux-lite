import { useEffect, useState } from 'react'
import { ShieldCheck, UserPlus } from 'lucide-react'
import type { WorkerDTO } from '../api/dto.ts'
import type { ReturnTypeOfCreateApi } from '../api/team-types.ts'
import { Button } from './ui/button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.tsx'

export function WorkerAccessPanel({ api, worker, onChanged }: { api: ReturnTypeOfCreateApi; worker: WorkerDTO; onChanged: () => void }) {
  const [members, setMembers] = useState<Awaited<ReturnType<typeof api.teamMembers>>>([])
  const [grants, setGrants] = useState<Awaited<ReturnType<typeof api.workerGrants>>>([])
  const [userId, setUserId] = useState(''), [role, setRole] = useState<'use' | 'manage'>('use')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const canManage = worker.accessRole === 'owner' || worker.accessRole === 'manage'
  const load = async () => {
    if (!canManage) return
    const [nextMembers, nextGrants] = await Promise.all([api.teamMembers(worker.teamId), api.workerGrants(worker.id)])
    setMembers(nextMembers); setGrants(nextGrants)
  }
  useEffect(() => { void load().catch(cause => setError(cause instanceof Error ? cause.message : '读取工作节点权限失败')) }, [api, worker.id, worker.teamId, canManage])
  if (!canManage) return <p className="mt-3 rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">你拥有 use 权限，可以选择该节点执行，但不能管理共享范围或成员授权。</p>
  const grantable = members.filter(member => member.user.id !== worker.ownerId)
  const saveScope = async (shareScope: WorkerDTO['shareScope']) => { setBusy(true); setError(''); try { await api.updateWorkerAccess(worker.id, shareScope); onChanged() } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败') } finally { setBusy(false) } }
  const saveGrant = async () => { if (!userId) return; setBusy(true); setError(''); try { await api.grantWorker(worker.id, userId, role); await load() } catch (cause) { setError(cause instanceof Error ? cause.message : '授权失败') } finally { setBusy(false) } }
  return <details className="mt-3 border-t border-border pt-3 text-xs">
    <summary className="flex cursor-pointer items-center gap-2 font-medium text-foreground"><ShieldCheck className="size-3.5" />节点访问权限</summary>
    <div className="mt-3 grid gap-3">
      {error && <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 p-2 text-red-300">{error}</p>}
      <label className="grid gap-1.5"><span>共享范围</span><Select value={worker.shareScope} disabled={busy} onValueChange={value => void saveScope(value as WorkerDTO['shareScope'])}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="owner-only">仅 owner</SelectItem><SelectItem value="selected-members">指定成员</SelectItem><SelectItem value="team">Team 全员可使用</SelectItem></SelectContent></Select></label>
      <div className="grid gap-2"><span>成员 Grant</span><div className="grid gap-2 sm:grid-cols-[1fr_8rem_auto]"><Select value={userId} onValueChange={setUserId}><SelectTrigger><SelectValue placeholder="选择团队成员" /></SelectTrigger><SelectContent>{grantable.map(member => <SelectItem key={member.user.id} value={member.user.id}>{member.user.username}</SelectItem>)}</SelectContent></Select><Select value={role} onValueChange={value => setRole(value as typeof role)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="use">use</SelectItem><SelectItem value="manage">manage</SelectItem></SelectContent></Select><Button size="sm" disabled={busy || !userId} onClick={() => void saveGrant()}><UserPlus className="size-3.5" />授权</Button></div>
        <div className="grid gap-1.5">{grants.map(grant => { const member = members.find(value => value.user.id === grant.userId); return <div key={grant.userId} className="flex items-center justify-between rounded-lg border px-2.5 py-2"><span>{member?.user.username ?? grant.userId}</span><span className="flex items-center gap-2 text-muted-foreground">{grant.role}<Button size="sm" variant="ghost" disabled={busy} onClick={() => void api.revokeWorkerGrant(worker.id, grant.userId).then(load)}>移除</Button></span></div> })}</div>
      </div>
    </div>
  </details>
}
