import type { WorkerDTO, WorkspaceDTO } from '@wemux/web-contract/browser-host'

export interface TaskSessionOption {
  key: string
  label: string
  workspaceId: string
  workerId: string
  agentKey: string
  modelId: string
}
/** Discovery is a selection aid; the Server rechecks permissions and availability on creation. */
export function taskSessionOptions(projectId: string, teamId: string, workspaces: readonly WorkspaceDTO[], workers: readonly WorkerDTO[]): TaskSessionOption[] {
  return workspaces.filter(workspace => workspace.projectId === projectId && !workspace.deletedAt).flatMap(workspace =>
    workspace.placements.filter(placement => placement.status === 'ready').flatMap(placement =>
      workers.filter(worker => worker.id === placement.workerId && worker.teamId === teamId && worker.connectionState === 'online').flatMap(worker =>
        worker.capabilities.filter(agent => agent.mode === 'execution' && agent.availability.status === 'available').flatMap(agent =>
          agent.models.filter(model => model.modelId.trim()).map(model => ({
            key: JSON.stringify([workspace.id, worker.id, agent.agentKey, model.modelId]),
            label: `${workspace.name} / ${worker.name} / ${agent.displayName} / ${model.displayName}（${model.modelId}）`,
            workspaceId: workspace.id, workerId: worker.id, agentKey: agent.agentKey, modelId: model.modelId,
          })))))
  )
}
