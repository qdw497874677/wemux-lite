import { useEffect, useState } from 'react'
import { LoaderCircle, MailPlus, ShieldCheck, Users } from 'lucide-react'
import type { ReturnTypeOfCreateApi } from '../api/team-types.ts'
import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'

export function TeamPage({ api }: { api: ReturnTypeOfCreateApi }) {
  const [teams, setTeams] = useState<Awaited<ReturnType<typeof api.teams>>>([])
  const [members, setMembers] = useState<Awaited<ReturnType<typeof api.teamMembers>>>([])
  const [invitations, setInvitations] = useState<Awaited<ReturnType<typeof api.teamInvitations>>>([])
  const [selected, setSelected] = useState('')
  const [teamName, setTeamName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const loadTeams = async () => { const values = await api.teams(); setTeams(values); setSelected(value => value || values[0]?.id || '') }
  const loadTeam = async (id: string) => { const [nextMembers, nextInvitations] = await Promise.all([api.teamMembers(id), api.teamInvitations(id).catch(() => [])]); setMembers(nextMembers); setInvitations(nextInvitations) }
  useEffect(() => { void api.teams().then(values => { setTeams(values); setSelected(value => value || values[0]?.id || '') }).catch(cause => setError(cause instanceof Error ? cause.message : '读取团队失败')) }, [api])
  useEffect(() => { if (selected) void Promise.all([api.teamMembers(selected), api.teamInvitations(selected).catch(() => [])]).then(([nextMembers, nextInvitations]) => { setMembers(nextMembers); setInvitations(nextInvitations) }).catch(cause => setError(cause instanceof Error ? cause.message : '读取团队成员失败')) }, [api, selected])
  const create = async () => { if (!teamName.trim()) return; setBusy('create'); setError(''); try { const team = await api.createTeam(teamName.trim()); setTeamName(''); await loadTeams(); setSelected(team.id) } catch (cause) { setError(cause instanceof Error ? cause.message : '创建失败') } finally { setBusy('') } }
  const invite = async () => { if (!selected || !email.trim()) return; setBusy('invite'); setError(''); try { await api.inviteTeamMember(selected, email.trim()); setEmail(''); await loadTeam(selected) } catch (cause) { setError(cause instanceof Error ? cause.message : '邀请失败') } finally { setBusy('') } }
  const selectedTeam = teams.find(team => team.id === selected)
  const canManage = selectedTeam?.role === 'owner' || selectedTeam?.role === 'admin'
  return <main className="mx-auto grid w-full max-w-5xl gap-6 p-4 sm:p-8">
    <header className="grid gap-2"><p className="text-xs font-semibold uppercase tracking-[.18em] text-muted-foreground">Team network</p><h1 className="text-3xl font-semibold">团队与成员</h1><p className="text-sm text-muted-foreground">创建协作边界，通过指定邮箱邀请成员加入 Agent 网络。</p></header>
    {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    <section className="grid gap-3 rounded-2xl border bg-card p-5"><h2 className="font-semibold">创建团队</h2><div className="flex gap-2"><Input value={teamName} placeholder="团队名称" onChange={event => setTeamName(event.target.value)} /><Button disabled={busy !== '' || !teamName.trim()} onClick={() => void create()}>{busy === 'create' && <LoaderCircle className="size-4 animate-spin" />}创建</Button></div></section>
    {teams.length > 0 && <><nav className="flex flex-wrap gap-2" aria-label="团队"><select className="h-10 rounded-lg border bg-background px-3 text-sm" value={selected} onChange={event => setSelected(event.target.value)}>{teams.map(team => <option key={team.id} value={team.id}>{team.name} · {team.memberCount} 人</option>)}</select></nav>
      {canManage && <section className="grid gap-3 rounded-2xl border bg-card p-5"><h2 className="flex items-center gap-2 font-semibold"><MailPlus className="size-4" />邀请成员</h2><div className="flex gap-2"><Input type="email" value={email} placeholder="member@example.com" onChange={event => setEmail(event.target.value)} /><Button disabled={busy !== '' || !email.trim()} onClick={() => void invite()}>{busy === 'invite' && <LoaderCircle className="size-4 animate-spin" />}发送邀请</Button></div><div className="grid gap-2">{invitations.map(item => <div key={item.id} className="flex items-center justify-between rounded-xl border px-3 py-2 text-sm"><span>{item.email}</span><span className="text-muted-foreground">{item.status === 'pending' ? '待接受' : item.status}</span></div>)}</div></section>}
      <section className="grid gap-3 rounded-2xl border bg-card p-5"><h2 className="flex items-center gap-2 font-semibold"><Users className="size-4" />成员</h2>{members.map(item => <article key={item.user.id} className="flex items-center justify-between rounded-xl border px-4 py-3"><div><p className="font-medium">{item.user.username}</p><p className="text-xs text-muted-foreground">{item.user.email}</p></div><span className="flex items-center gap-1 text-xs text-muted-foreground">{item.role !== 'member' && <ShieldCheck className="size-3.5" />}{item.role}</span></article>)}</section></>}
    {teams.length === 0 && <p className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">还没有团队。创建一个团队后即可邀请成员协作。</p>}
  </main>
}
