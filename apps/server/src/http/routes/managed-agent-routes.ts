import { AppError } from '../../application/errors.ts'
import { agentManifest } from '../agent-downloads.ts'
import type { RouteDescriptor, RouteRequestContext } from './types.ts'

/**
 * 托管 Agent 安装的管理面入口：既提供固定版本目录（Web 无法读取公开 /downloads 路径，
 * 因为客户端只允许调用 /api/**），也承接管理员显式确认后的下发。
 */
const service = (context: RouteRequestContext) => {
  if (!context.resources) throw new AppError(404, 'Route not found')
  return context.resources
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'Invalid managed agent request', 'invalid_request')
  return value as Record<string, unknown>
}

const conflicts = new Set(['managed_agent_binding_conflict', 'managed_agent_binding_retired'])

function installError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error('Managed agent install failed')
  if (error.message === 'invalid_managed_agent_key') return new AppError(400, 'Unsupported managed agent key', error.message)
  if (conflicts.has(error.message)) return new AppError(409, 'Managed agent binding has changed; refresh and retry', error.message)
  return error
}

export const managedAgentRoutes: readonly RouteDescriptor[] = [
  {
    method: 'GET', pattern: '/managed-agent-catalog', auth: 'admin', handler: async context => {
      await context.operator()
      context.json(200, { ...agentManifest(), generatedAt: new Date().toISOString() })
    },
  },
  {
    method: 'POST', pattern: '/managed-agent-installs', auth: 'admin', handler: async context => {
      const actor = await context.operator()
      const body = object(await context.readBody())
      if (typeof body.workerId !== 'string' || !body.workerId) throw new AppError(400, 'Missing managed agent install fields', 'invalid_request')
      if (typeof body.agentKey !== 'string' || !body.agentKey) throw new AppError(400, 'Missing managed agent install fields', 'invalid_request')
      const worker = (await context.service.listWorkers()).find(item => item.id === body.workerId)
      if (!worker) throw new AppError(404, 'Worker not found', 'worker_not_found')
      try {
        context.json(201, await service(context).installManagedAgent({ workerId: worker.id, agentKey: body.agentKey, createdBy: actor }))
      } catch (error) {
        throw installError(error)
      }
    },
  },
]
