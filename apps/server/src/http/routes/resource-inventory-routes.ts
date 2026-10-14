import { AppError } from '../../application/errors.ts'
import type { RouteDescriptor, RouteRequestContext } from './types.ts'

const service = (context: RouteRequestContext) => {
  if (!context.resourceInventory) throw new AppError(404, 'Route not found')
  return context.resourceInventory
}

/**
 * Read-only management projection: every entry states what the Server declared
 * and what the Worker actually probed, without collapsing the four axes.
 */
export const resourceInventoryRoutes: readonly RouteDescriptor[] = [
  { method: 'GET', pattern: '/resource-inventory', auth: 'admin', handler: async context => {
    await context.operator()
    context.json(200, await service(context).inventory())
  } },
]
