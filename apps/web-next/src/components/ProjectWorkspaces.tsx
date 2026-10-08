import { WorkspaceDeletion } from './WorkspaceDeletion.tsx'
import type { ProjectDTO, WorkspaceDTO } from '@wemux/web-contract/browser-host'
import { useCreateIntent, usePlacementRetryIntents, type ProjectClient } from './ProjectManagement.tsx'
import { AccountSection, ActionForm, useAccountData } from './AccountForms.tsx'
import { Button } from './primitives.tsx'
const states = { ready: '已就绪', stopped: '未就绪 / 准备中', deleted: '已删除', failed: '准备失败', unhealthy: '节点不可用' }
export function ProjectWorkspaces({ api, project, administrator }: { api: ProjectClient; project: ProjectDTO; administrator: boolean }) {
  const state = useAccountData(() => Promise.all([api.workspaces(project.id, 'all'), api.workers()]), [api, project.id, project.accessRole])
  const intent = useCreateIntent(), retry = usePlacementRetryIntents(), visibility = usePlacementRetryIntents()
  async function changeVisibility(workspace: WorkspaceDTO, hidden: boolean) {
    const expectedRevision = workspace.visibilityRevision ?? 0
    const scope = [project.id, workspace.id, String(hidden), String(expectedRevision)]
    const requestId = visibility.id(scope)
    try {
      await api.setWorkspaceVisibility(workspace.id, { hidden, expectedRevision, requestId })
      visibility.acknowledge(scope, requestId)
      state.reload()
      return hidden ? '隐藏请求已提交；列表正在刷新。工作区、文件和准备请求未删除或停止。若刷新失败，请手动重试。' : '恢复请求已提交；列表正在刷新。若刷新失败，请手动重试。'
    } catch (cause) {
      // A CAS conflict must fetch a fresh list revision before a new intent can be issued.
      state.reload()
      throw cause
    }
  }
  const workers = state.data?.[1] ?? []
  const visibleWorkspaces = state.data?.[0].filter(workspace => !workspace.visibilityHidden) ?? []
  const hiddenWorkspaces = state.data?.[0].filter(workspace => workspace.visibilityHidden) ?? []
  function renderWorkspace(workspace: WorkspaceDTO, hidden: boolean) {
    return <article className="account-row" key={workspace.id}><h3>{workspace.name}</h3><p>{workspace.spec.kind === 'repository' ? `已关联 Repository：${workspace.spec.repositoryId}` : '空工作区'}</p>{!workspace.placements.length && <p>尚无 Worker Placement。</p>}{workspace.placements.map(placement => <div key={placement.workerId}><p>{workers.find(worker => worker.id === placement.workerId)?.name ?? '不可访问的 Worker'}：{states[placement.status]}</p>{placement.failureReason && <p role="alert">{placement.failureReason}</p>}<p className="machine">{placement.location?.rootPath ?? '尚无已确认路径'}</p>{!hidden && administrator && <><ActionForm label="重试准备" submit={async () => { const body = [project.id, workspace.id, placement.workerId]; const requestId = retry.id(body); await api.retryWorkspace(workspace.id, placement.workerId, requestId); retry.acknowledge(body, requestId); state.reload(); return '准备请求已提交。' }} />{placement.provisioning && <p className="muted">准备取消暂不可用。已提交的准备请求会继续处理；关闭页面或表单不会停止 Worker，也不会回滚或删除文件。</p>}</>}{hidden && placement.provisioning && <p className="muted">准备仍可能继续；隐藏不会停止 Worker。准备取消暂不可用。</p>}</div>)}
      {hidden ? <ActionForm label="恢复到我的列表" submit={() => changeVisibility(workspace, false)} /> : <>
        {administrator && <ActionForm label="新增 Worker 落点" submit={async ({ workerId }) => { const body = [project.id, workspace.id, workerId]; const requestId = retry.id(body); await api.retryWorkspace(workspace.id, workerId, requestId); retry.acknowledge(body, requestId); state.reload(); return '落点准备已提交。' }}><label>新增落点 Worker<select name="workerId" required><option value="">选择 Worker</option>{workers.filter(worker => worker.teamId === project.teamId && worker.connectionState !== 'revoked' && !workspace.placements.some(placement => placement.workerId === worker.id)).map(worker => <option key={worker.id} value={worker.id}>{worker.name}</option>)}</select></label></ActionForm>}
        {administrator && <ActionForm label="保存工作区名称" fields={[{ name: 'name', label: '工作区名称', value: workspace.name }]} submit={async ({ name }) => { await api.renameWorkspace(workspace.id, name); state.reload(); return '工作区名称已保存。' }} />}
        <ActionForm label="从我的列表隐藏" confirm="仅对你隐藏此工作区？不会删除工作区或文件，也不会停止 Worker；之后可在已隐藏列表手动恢复。" submit={() => changeVisibility(workspace, true)} />
        {['owner', 'manager'].includes(project.accessRole) && <WorkspaceDeletion api={api} workspace={workspace} changed={state.reload} />}
      </>}
    </article>
  }
  return <AccountSection title="工作区"><Button variant="outline" onClick={state.reload}>刷新准备状态</Button>{state.feedback}
    {project.accessRole !== 'viewer' && state.data && <ActionForm label="创建工作区" fields={[{ name: 'name', label: '工作区名称' }, { name: 'gitUrl', label: 'Git 仓库 URL（留空创建空工作区）', required: false }, { name: 'revision', label: '分支或版本（默认 main）', required: false }]} submit={async ({ name, workerId, gitUrl, revision }) => { const body = { name, ...(workerId ? { workerId } : {}), source: gitUrl ? 'git' as const : 'empty' as const, ...(gitUrl ? { repository: { gitUrl, ...(revision ? { revision } : {}) } } : {}) }; await api.createWorkspace(project.id, { ...body, requestId: intent.id(body) }); intent.complete(); state.reload(); return '工作区已登记；准备结果请刷新查看，不代表文件已就绪。' }}><label>Worker 落点<select name="workerId"><option value="">暂不放置</option>{workers.filter(worker => worker.teamId === project.teamId && worker.connectionState !== 'revoked').map(worker => <option key={worker.id} value={worker.id}>{worker.name}（{worker.connectionState === 'online' ? '在线' : '离线'}）</option>)}</select></label></ActionForm>}
    <h3>当前工作区</h3>
    {state.data && (visibleWorkspaces.length ? visibleWorkspaces.map(workspace => renderWorkspace(workspace, false)) : <p>暂无可见工作区。</p>)}
    <h3>已隐藏（仅对你）</h3>
    {state.data && (hiddenWorkspaces.length ? hiddenWorkspaces.map(workspace => renderWorkspace(workspace, true)) : <p>暂无已隐藏工作区。</p>)}
    <p className="migration-note">当前支持保留文件的逻辑删除；独立管理 Repository 或修改已关联仓库尚不支持。工作区目录不会随任务解绑而删除。新增落点与准备重试仅向实例管理员开放。准备取消暂不可用，接口拒绝不代表工作已停止。</p>
  </AccountSection>
}
