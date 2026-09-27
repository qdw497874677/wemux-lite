import { useEffect, useState } from 'react'
import { ArrowLeft, Crown, LoaderCircle, MailPlus, ShieldCheck, Trash2, Users } from 'lucide-react'
import type { ReturnTypeOfCreateApi } from '../api/team-types.ts'
import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { useConfirmDialog } from './ui/confirm-dialog.tsx'

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
  const changeRole = async (userId: string, role: 'admin' | 'member') => run(`role:${userId}`, async () => { await api.updateTeamMemberRole(selected, userId, role); await loadTeam(selected); setNotice(`成员角色已调整为 ${role}`) }, '调整角色失败')
  const remove = async (userId: string, username: string) => { if (!await confirm({ title: '移除团队成员', description: `确认将 ${username} 移出团队？其 Project、Worker、Session 授权会立即撤销；活跃任务会请求停止，离线 Worker 下命令将保持待送达。`, confirmLabel: '移除', danger: true })) return; await run(`remove:${userId}`, async () => { await api.removeTeamMember(selected, userId); await loadTeam(selected); await loadTeams(); setNotice('成员已移除。授权已立即撤销；活跃任务的停止命令可能仍在等待 Worker 上线送达。') }, '移除成员失败') }
  const transfer = async (userId: string, username: string) => { const name = selectedTeam?.name ?? ''; if (!await confirm({ title: '转移团队所有权', description: `确认把 ${name} 的所有权转移给 ${username}？你将降为 admin。`, confirmLabel: '转移所有权', danger: true })) return; await run(`owner:${userId}`, async () => { await api.transferTeamOwnership(selected, userId, name); await loadTeam(selected); await loadTeams(); setNotice(`团队所有权已转移给 ${username}`) }, '转移所有权失败') }
  const selectedTeam = teams.find(team => team.id === selected)
  const canManage = selectedTeam?.role === 'owner' || selectedTeam?.role === 'admin'
  const isOwner = selectedTeam?.role === 'owner'
  return <main className="mx-auto grid w-full max-w-5xl gap-6 p-4 sm:p-8">
    <header className="grid gap-3"><Button variant="ghost" size="sm" className="w-fit -ml-2" onClick={onBack}><ArrowLeft className="size-4" />返回工作台</Button><div className="grid gap-2"><p className="text-xs font-semibold uppercase tracking-[.18em] text-muted-foreground">Team network</p><h1 className="text-3xl font-semibold">团队与成员</h1><p className="text-sm text-muted-foreground">管理协作边界、成员角色和实时访问权限。</p></div></header>
    {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="rounded-xl border border-primary/25 bg-primary/5 p-3 text-sm">{notice}</p>}
    <section className="grid gap-3 rounded-2xl border bg-card p-5"><h2 className="font-semibold">创建团队</h2><div className="flex gap-2"><Input value={teamName} placeholder="团队名称" onChange={event => setTeamName(event.target.value)} /><Button disabled={busy !== '' || !teamName.trim()} onClick={() => void create()}>{busy === 'create' && <LoaderCircle className="size-4 animate-spin" />}创建</Button></div></section>
    {teams.length > 0 && <><nav className="flex flex-wrap gap-2" aria-label="团队"><select className="h-10 rounded-lg border bg-background px-3 text-sm" value={selected} onChange={event => setSelected(event.target.value)}>{teams.map(team => <option key={team.id} value={team.id}>{team.name} · {team.memberCount} 人</option>)}</select></nav>
      {canManage && <section className="grid gap-3 rounded-2xl border bg-card p-5"><h2 className="flex items-center gap-2 font-semibold"><MailPlus className="size-4" />邀请成员</h2><div className="flex gap-2"><Input type="email" value={email} placeholder="member@example.com" onChange={event => setEmail(event.target.value)} /><Button disabled={busy !== '' || !email.trim()} onClick={() => void invite()}>{busy === 'invite' && <LoaderCircle className="size-4 animate-spin" />}发送邀请</Button></div><div className="grid gap-2">{invitations.map(item => <div key={item.id} className="flex items-center justify-between rounded-xl border px-3 py-2 text-sm"><span>{item.email}</span><span className="text-muted-foreground">{item.status === 'pending' ? '待接受' : item.status}</span></div>)}</div></section>}
      <section className="grid gap-3 rounded-2xl border bg-card p-5"><div className="grid gap-1"><h2 className="flex items-center gap-2 font-semibold"><Users className="size-4" />成员</h2><p className="text-xs text-muted-foreground">移除成员后，访问会立即失效；活跃任务的停止命令在 Worker 离线时显示为待送达。</p></div>{members.map(item => <article key={item.user.id} className="flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium">{item.user.username}</p><p className="text-xs text-muted-foreground">{item.user.email}</p></div><div className="flex flex-wrap items-center gap-2"><span className="flex items-center gap-1 text-xs text-muted-foreground">{item.role !== 'member' && <ShieldCheck className="size-3.5" />}{item.role}</span>{isOwner && item.role !== 'owner' && <><select aria-label={`调整 ${item.user.username} 的角色`} className="h-8 rounded-md border bg-background px-2 text-xs" value={item.role} disabled={busy !== ''} onChange={event => void changeRole(item.user.id, event.target.value as 'admin' | 'member')}><option value="member">member</option><option value="admin">admin</option></select><Button size="sm" variant="outline" disabled={busy !== ''} onClick={() => void transfer(item.user.id, item.user.username)}><Crown className="size-3.5" />转移所有权</Button></>}{canManage && item.role === 'member' && <Button size="sm" variant="outline" disabled={busy !== ''} onClick={() => void remove(item.user.id, item.user.username)}><Trash2 className="size-3.5" />移除</Button>}</div></article>)}</section></>}
    {teams.length === 0 && <p className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">还没有团队。创建一个团队后即可邀请成员协作。</p>}
  </main>
}
