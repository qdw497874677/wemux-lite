import type { AgentDTO, WorkerDTO } from '../../api/dto.ts'

export interface AgentPanelEntry extends AgentDTO {
  workerId: string
  workerName: string
}

export interface AgentWorkerGroup {
  workerId: string
  workerName: string
  agents: AgentPanelEntry[]
}

export function groupAgentsByWorker(workers: readonly WorkerDTO[]): AgentWorkerGroup[] {
  return workers.map(worker => ({
    workerId: worker.id,
    workerName: worker.name,
    agents: worker.capabilities.map(agent => ({ ...agent, workerId: worker.id, workerName: worker.name })),
  }))
}

export function countAvailableAgents(workers: readonly WorkerDTO[]): number {
  return workers.reduce((sum, worker) => sum + worker.capabilities.filter(agent => agent.availability.status === 'available').length, 0)
}
