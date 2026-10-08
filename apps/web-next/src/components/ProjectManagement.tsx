import { PlacementRetryIntents } from '../lib/placement-retry-intents.ts'
import { useOperationLifetime } from '../lib/operation-lifetime.ts'
import { useRef, useState, useEffect } from 'react'
import { randomId } from '@wemux/web-client'
import type { ProjectDTO } from '@wemux/web-contract/browser-host'
import type { Application } from '../application.ts'
import { ActionForm, AccountSection, ConfirmButton, useAccountData } from './AccountForms.tsx'
import { ProjectWorkspaces } from './ProjectWorkspaces.tsx'
import { ProjectTasks } from './ProjectTasks.tsx'
import { ProjectConversation } from './ProjectConversation.tsx'
import { Button } from './primitives.tsx'
import { confirmNavigation } from '../lib/unsaved-navigation.ts'
import { navigate } from '../lib/navigation.ts'
export type ProjectClient = NonNullable<ReturnType<Application['getClient']>>
/** An uncertain retry retains its identity; a successful submission starts a new intent. */
export function useCreateIntent() {
  const intent = useRef({ body: '', id: randomId() })
  return { id(body: unknown) { const encoded = JSON.stringify(body); if (intent.current.body !== encoded) intent.current = { body: encoded, id: randomId() }; return intent.current.id }, complete() { intent.current = { body: '', id: randomId() } } }
}
export function usePlacementRetryIntents() {
  const [intents] = useState(() => new PlacementRetryIntents(randomId))
  return intents
}
export function ProjectCreate({ api, teamId, reload }: { api: ProjectClient; teamId: string; reload: () => Promise<void> }) {
  const intent = useCreateIntent()
  const begin = useOperationLifetime([api, teamId])
  return <AccountSection title="新建项目"><ActionForm label="创建项目" fields={[{ name: 'name', label: '项目名称' }]} submit={async ({ name }) => { const active = begin(); const body = { name, teamId }; const project = await api.createProject({ ...body, requestId: intent.id(body) }); if (!active()) return; intent.complete(); await reload(); if (!active()) return; navigate(`/next/projects/${project.id}`) }} /></AccountSection>
}
export function ProjectManagement({ api, project, administrator, reload, search }: { api: ProjectClient; project: ProjectDTO; administrator: boolean; reload: () => Promise<void>; search: string }) {
  const [tab, setTab] = useState('tasks')
  useEffect(() => { if (new URLSearchParams(search).has('task')) setTab('tasks') }, [search])
  return <><nav className="account-actions" aria-label="项目管理"><Button variant={tab === 'tasks' ? 'default' : 'outline'} onClick={() => confirmNavigation() && setTab('tasks')}>任务</Button><Button variant={tab === 'workspaces' ? 'default' : 'outline'} onClick={() => confirmNavigation() && setTab('workspaces')}>工作区</Button><Button variant={tab === 'conversation' ? 'default' : 'outline'} onClick={() => confirmNavigation() && setTab('conversation')}>试聊</Button><Button variant={tab === 'settings' ? 'default' : 'outline'} onClick={() => confirmNavigation() && setTab('settings')}>项目设置</Button></nav>
    {tab === 'tasks' ? <ProjectTasks api={api} project={project} search={search} /> : tab === 'workspaces' ? <ProjectWorkspaces api={api} project={project} administrator={administrator} /> : tab === 'conversation' ? <ProjectConversation api={api} project={project} /> : <>
      {administrator && ['owner', 'manager'].includes(project.accessRole) ? <AccountSection title="项目配置"><p>即使列表为空，项目内保留的已删除任务/工作区历史仍会阻止项目删除；不会级联清理。</p><ActionForm label="保存项目名称" fields={[{ name: 'name', label: '项目名称', value: project.name }]} submit={async ({ name }) => { await api.renameProject(project.id, name); await reload(); return '项目名称已保存。' }} /><ConfirmButton confirm="删除项目？保留任何工作区或任务记录（包括已逻辑删除）时服务端将拒绝，不会清理文件。" act={async () => { await api.deleteProject(project.id); await reload(); navigate('/next/projects') }}>删除项目</ConfirmButton></AccountSection> : <p>项目改名和删除需要实例管理员身份以及当前项目所有者或管理者权限。</p>}
      {['owner', 'manager'].includes(project.accessRole) ? <ProjectAccess key={project.reviewPolicyVersion ?? 1} api={api} project={project} reload={reload} /> : <p>当前项目角色无权管理共享范围和成员授权。</p>}
    </>}
  </>
}
function ProjectAccess({ api, project, reload }: { api: ProjectClient; project: ProjectDTO; reload: () => Promise<void> }) {
  const state = useAccountData(() => Promise.all([api.teamMembers(project.teamId), api.projectGrants(project.id)]), [api, project.id, project.accessRole])
  return <AccountSection title="项目访问">{state.feedback}<p>项目默认审查：{({ none: '不强制审查', agent: 'Agent 审查', human: '人工审查', 'multi-stage': '多阶段审查' } as const)[project.reviewPolicy ?? 'none']}。启动执行前的任务继承此设置；已启动任务的要求不随默认值降低。配置审查的决定入口尚未接入，选择后不能直接提交完成。</p><ActionForm label="保存默认审查要求" submit={async ({ reviewPolicy }) => { const result = await api.updateProjectReviewPolicy(project.id, reviewPolicy as NonNullable<ProjectDTO['reviewPolicy']>, project.reviewPolicyVersion ?? 1); await reload(); return `已保存项目默认审查：${result.reviewPolicy === 'none' ? '不强制审查' : result.reviewPolicy === 'human' ? '人工审查' : result.reviewPolicy === 'agent' ? 'Agent 审查' : '多阶段审查'}。` }}><label>默认审查策略<select name="reviewPolicy" defaultValue={project.reviewPolicy ?? 'none'}><option value="none">不强制审查</option><option value="human">人工审查（可提交，决定入口待接入）</option><option value="agent">Agent 审查（决定入口待接入）</option><option value="multi-stage">多阶段审查（决定入口待接入）</option></select></label></ActionForm><ActionForm label="保存共享范围" submit={async ({ scope }) => { await api.updateProjectAccess(project.id, scope as ProjectDTO['shareScope']); await reload(); return '共享范围已保存。' }}><label>共享范围<select name="scope" defaultValue={project.shareScope}><option value="owner-only">仅所有者</option><option value="selected-members">指定成员</option><option value="team">团队全员只读</option></select></label></ActionForm>
    {state.data && <><ActionForm label="授予项目权限" submit={async ({ userId, role }) => { await api.grantProject(project.id, userId, role as 'viewer'); state.reload(); return '项目权限已保存。' }}><label>团队成员<select name="userId" required>{state.data[0].filter(member => member.user.id !== project.ownerId).map(member => <option key={member.user.id} value={member.user.id}>{member.user.username}</option>)}</select></label><label>项目角色<select name="role"><option value="viewer">只读成员</option><option value="contributor">协作者</option><option value="manager">管理者</option></select></label></ActionForm>
      {state.data[1].map(grant => <div className="account-row" key={grant.userId}>{state.data![0].find(member => member.user.id === grant.userId)?.user.username ?? '团队成员'}：{grant.role}<ConfirmButton confirm="撤销该成员的项目授权？团队可见项目仍提供只读访问。" act={async () => { await api.revokeProjectGrant(project.id, grant.userId); state.reload(); return '项目授权已撤销。' }}>撤销授权</ConfirmButton></div>)}</>}
  </AccountSection>
}
