import type { TaskDetail } from '@wemux/web-contract/task-platform'
import type { WorkspaceDTO, WorkerDTO } from '@wemux/web-contract/browser-host'
import { useCreateIntent, usePlacementRetryIntents, type ProjectClient } from './ProjectManagement.tsx'
import { ActionForm } from './AccountForms.tsx'

/** Creates and binds in one server transaction; always reload current Task after a replay. */
export function TaskWorkspaces({ api, task, workspaces, workers, teamId, changed }: { api: ProjectClient; task: TaskDetail; workspaces: WorkspaceDTO[]; workers: WorkerDTO[]; teamId: string; changed: () => void }) {
  const create = useCreateIntent(), retry = usePlacementRetryIntents()
  return <><h3>在任务内新建工作区</h3><ActionForm label="创建并绑定工作区" fields={[{ name: 'name', label: '任务工作区名称' }, { name: 'gitUrl', label: '任务仓库 URL（可选）', required: false }, { name: 'revision', label: '任务仓库版本（默认 main）', required: false }]} submit={async ({ name, workerId, gitUrl, revision }) => {
    const body = { name, workerId, source: gitUrl ? 'git' as const : 'empty' as const, ...(gitUrl ? { repository: { gitUrl, ...(revision ? { revision } : {}) } } : {}) }
    await api.createTaskWorkspace(task.projectId, task.id, { ...body, requestId: create.id(body) }); create.complete(); changed(); return '工作区已创建并绑定，准备结果以各落点报告为准。'
  }}><label>任务工作区 Worker<select name="workerId" required><option value="">选择执行节点</option>{workers.filter(worker => worker.teamId === teamId && worker.connectionState !== 'revoked').map(worker => <option key={worker.id} value={worker.id}>{worker.name}（{worker.connectionState === 'online' ? '在线' : '离线'}）</option>)}</select></label></ActionForm>
    {task.workspaces.map(binding => { const workspace = workspaces.find(item => item.id === binding.workspaceId); return workspace && <section className="account-row" key={workspace.id} aria-label={`${workspace.name} 准备状态`}><h4>{workspace.name} 准备状态</h4>{workspace.placements.map(placement => <div key={placement.workerId}><p>{workers.find(worker => worker.id === placement.workerId)?.name ?? '不可访问的 Worker'}：{placement.status}</p>{placement.failureReason && <p role="alert">{placement.failureReason}</p>}<p className="machine">{placement.location?.rootPath ?? '尚无已确认路径'}</p>{placement.status !== 'ready' && placement.status !== 'deleted' && <ActionForm label={`重试 ${workspace.name} 落点`} submit={async () => { const body = [task.id, workspace.id, placement.workerId]; const requestId = retry.id(body); await api.retryTaskWorkspace(task.projectId, task.id, workspace.id, placement.workerId, requestId); retry.acknowledge(body, requestId); changed(); return '任务落点准备已重新请求。' }} />}</div>)}</section> })}
    <p className="muted">新建后可在下方单独指派执行环境，指派仍使用当前任务版本校验。重试不迁移文件，不更改其他 Worker 落点。</p></>
}
