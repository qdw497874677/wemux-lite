import type { WorkerDTO } from '../api/dto'
type Capability = WorkerDTO['capabilities'][number]
export const isExecutable = (agent: Capability) => agent.mode === 'execution' && agent.availability.status === 'available'
export const capabilityLabel = (agent: Capability) => agent.mode !== 'execution' ? '仅检测' : agent.availability.status === 'authentication-required' ? '需要认证' : isExecutable(agent) ? '可执行' : '不可执行'
