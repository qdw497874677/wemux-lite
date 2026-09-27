import { useEffect, useState } from 'react'
import { ArrowLeft, Crown, LoaderCircle, MailPlus, ShieldCheck, Trash2, UserRound, Users } from 'lucide-react'
import type { ReturnTypeOfCreateApi } from '../api/team-types.ts'
import { Badge } from './ui/badge.tsx'
import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { useConfirmDialog } from './ui/confirm-dialog.tsx'

const roleLabel = { owner: '所有者', admin: '管理员', member: '成员' } as const

export function TeamPage({ api, onBack }: { api: ReturnTypeOfCreateApi; onBack: () => void }) {
  const confirm = useConfirmDialog()
  const [teams, setTeams] = useState<Awaited<ReturnType<typeof api.teams>>>([])
  const [members, setMembers] = useState<Awaited<ReturnType<typeof api.teamMembers>>>([])
  const [invitations, setInvitations] = useState<Awaited<ReturnType<typeof api.teamInvitations>>>([])
  const [selected, setSelected] = useState('')
  const [teamName, setTeamName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const loadTeams = async () => { const values = await api.teams(); setTeams(values); setSelected(value => value || values[0]?.id || '') }
  const loadTeam = async (teamId: string) => { const [nextMembers, nextInvitations] = await Promise.all([api.teamMembers(teamId), api.teamInvitations(teamId).catch(() => [])]); setMembers(nextMembers); setInvitations(nextInvitations) }
  useEffect(() => { void api.teams().then(values => { setTeams(values); setSelected(value => value || values[0]?.id || '') }).catch(cause => setError(cause instanceof Error ? cause.message : '读取团队失败')) }, [api])
  useEffect(() => { if (selected) void Promise.all([api.teamMembers(selected), api.teamInvitations(selected).catch(() => [])]).then(([nextMembers, nextInvitations]) => { setMembers(nextMembers); setInvitations(nextInvitations) }).catch(cause => setError(cause instanceof Error ? cause.message : '读取团队成员失败')) }, [api, selected])
  const run = async (key: string, work: () => Promise<void>, fallback: string) => { setBusy(key); setError(''); setNotice(''); try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : fallback) } finally { setBusy('') } }
  const create = async () => { if (!teamName.trim()) return; await run('create', async () => { const team = await api.createTeam(teamName.trim()); setTeamName(''); await loadTeams(); setSelected(team.id) }, '创建失败') }
  const invite = async () => { if (!selected || !email.trim()) return; await run('invite', async () => { await api.inviteTeamMember(selected, email.trim()); setEmail(''); await loadTeam(selected) }, '邀请失败') }
  const changeRole = async (userId: string, role: 'admin' | 'member') => run(`role:${userId}`, async () => { await api.updateTeamMemberRole(selected, userId, role); await loadTeam(selected); setNotice(`成员角色已调整为 ${roleLabel[role]}`) }, '调整角色失败')
  const remove = async (userId: string, username: string) => { if (!await confirm({ title: '移除团队成员', description: `确认将 ${username} 移出团队？其 Project、Worker、Session 授权会立即撤销；活跃任务会请求停止，离线 Worker 下命令将保持待送达。`, confirmLabel: '移除', danger: true })) return; await run(`remove:${userId}`, async () => { await api.removeTeamMember(selected, userId); await loadTeam(selected); await loadTeams(); setNotice('成员已移除。授权已立即撤销；活跃任务的停止命令可能仍在等待 Worker 上线送达。') }, '移除成员失败') }
  const transfer = async (userId: string, username: string) => { const name = selectedTeam?.name ?? ''; if (!await confirm({ title: '转移团队所有权', description: `确认把 ${name} 的所有权转移给 ${username}？你将降为管理员。`, confirmLabel: '转移所有权', danger: true })) return; await run(`owner:${userId}`, async () => { await api.transferTeamOwnership(selected, userId, name); await loadTeam(selected); await loadTeams(); setNotice(`团队所有权已转移给 ${username}`) }, '转移所有权失败') }
  const selectedTeam = teams.find(team => team.id === selected)
  const canManage = selectedTeam?.role === 'owner' || selectedTeam?.role === 'admin'
  const isOwner = selectedTeam?.role === 'owner'

  return <main className="mx-auto w-full max-w-6xl space-y-4 px-3 py-3 sm:px-5 sm:py-4">
    <header className="flex min-h-10 items-center justify-between gap-3 border-b border-border pb-2">
      <div className="flex min-w-0 items-center gap-2"><Button variant="ghost" size="icon-sm" aria-label="返回项目" title="返回项目" onClick={onBack}><ArrowLeft className="size-4" /></Button><div className="min-w-0"><h1 className="text-sm font-medium">团队与成员</h1><p className="truncate text-xs text-muted-foreground">管理协作边界、成员角色和访问权限</p></div></div>
      {teams.length > 0 && <select aria-label="选择团队" className="h-8 max-w-56 rounded-lg border border-input bg-background px-2 text-xs" value={selected} onChange={event => setSelected(event.target.value)}>{teams.map(team => <option key={team.id} value={team.id}>{team.name} · {team.memberCount} 人</option>)}</select>}
    </header>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p>}
    {notice && <p role="status" className="rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-xs">{notice}</p>}

    <section className="rounded-lg border border-border bg-card p-3"><div className="mb-2"><h2 className="text-sm font-medium">创建团队</h2><p className="text-xs text-muted-foreground">为项目和成员建立独立协作边界。</p></div><div className="flex gap-2"><Input className="h-8" value={teamName} placeholder="团队名称" onChange={event => setTeamName(event.target.value)} /><Button size="sm" disabled={busy !== '' || !teamName.trim()} onClick={() => void create()}>{busy === 'create' && <LoaderCircle className="size-4 animate-spin" />}创建</Button></div></section>

    {teams.length > 0 && <>
      {canManage && <section className="rounded-lg border border-border bg-card p-3"><div className="mb-2 flex items-center gap-2"><MailPlus className="size-4 text-muted-foreground" /><div><h2 className="text-sm font-medium">邀请成员</h2><p className="text-xs text-muted-foreground">邀请邮件会包含一次性加入链接。</p></div></div><div className="flex gap-2"><Input className="h-8" type="email" value={email} placeholder="member@example.com" onChange={event => setEmail(event.target.value)} /><Button size="sm" disabled={busy !== '' || !email.trim()} onClick={() => void invite()}>{busy === 'invite' && <LoaderCircle className="size-4 animate-spin" />}发送邀请</Button></div>{invitations.length > 0 && <div className="mt-2 space-y-1">{invitations.map(item => <div key={item.id} className="flex items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-muted"><span className="grid size-8 place-items-center rounded-lg bg-muted"><MailPlus className="size-4 text-muted-foreground" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm">{item.email}</p><p className="text-xs text-muted-foreground">团队邀请</p></div><Badge variant={item.status === 'pending' ? 'warning' : 'outline'}>{item.status === 'pending' ? '待接受' : item.status}</Badge></div>)}</div>}</section>}

      <section className="rounded-lg border border-border bg-card p-2"><div className="flex items-center gap-2 px-2 py-1.5"><Users className="size-4 text-muted-foreground" /><div><h2 className="text-sm font-medium">成员</h2><p className="text-xs text-muted-foreground">移除成员后，相关访问权限立即失效。</p></div></div><div className="mt-1 space-y-1">{members.map(item => <article key={item.user.id} className="group flex items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-muted"><span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"><UserRound className="size-4" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.user.username}</p><p className="truncate text-xs text-muted-foreground">{item.user.email}</p></div><Badge variant={item.role === 'owner' ? 'default' : item.role === 'admin' ? 'success' : 'outline'}>{item.role !== 'member' && <ShieldCheck className="size-3" />}{roleLabel[item.role]}</Badge><div className="flex items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100">{isOwner && item.role !== 'owner' && <><select aria-label={`调整 ${item.user.username} 的角色`} className="h-8 rounded-lg border border-input bg-background px-2 text-xs" value={item.role} disabled={busy !== ''} onChange={event => void changeRole(item.user.id, event.target.value as 'admin' | 'member')}><option value="member">成员</option><option value="admin">管理员</option></select><Button size="icon-sm" variant="ghost" aria-label={`转移所有权给 ${item.user.username}`} title="转移所有权" disabled={busy !== ''} onClick={() => void transfer(item.user.id, item.user.username)}><Crown className="size-3.5" /></Button></>}{canManage && item.role === 'member' && <Button size="icon-sm" variant="ghost" className="text-destructive" aria-label={`移除 ${item.user.username}`} title="移除成员" disabled={busy !== ''} onClick={() => void remove(item.user.id, item.user.username)}><Trash2 className="size-3.5" /></Button>}</div></article>)}</div></section>
    </>}

    {teams.length === 0 && <div className="flex min-h-60 flex-col items-center justify-center text-center"><span className="mb-3 grid size-10 place-items-center rounded-lg bg-muted"><Users className="size-5 text-muted-foreground" /></span><p className="text-sm font-medium">还没有团队</p><p className="mt-1 text-xs text-muted-foreground">创建团队后即可邀请成员共同管理项目。</p></div>}
  </main>
}
