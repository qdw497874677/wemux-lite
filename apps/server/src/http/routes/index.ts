import { adminRoutes } from './admin-routes.ts'
import { authRoutes } from './auth-routes.ts'
import { canvasRoutes } from './canvas-routes.ts'
import { channelRoutes } from './channel-routes.ts'
import { genericWebhookRoutes } from './generic-webhook-routes.ts'
import { connectorRoutes } from './connector-routes.ts'
import { projectRoutes } from './project-routes.ts'
import { publicRoutes } from './public-routes.ts'
import { resourceRoutes } from './resource-routes.ts'
import { sessionRoutes } from './session-routes.ts'
import { taskRoutes } from './task-routes.ts'
import { teamRoutes } from './team-routes.ts'
import type { RouteDescriptor } from './types.ts'
import { workerRoutes } from './worker-routes.ts'
import { workspaceRoutes } from './workspace-routes.ts'

export const routes: readonly RouteDescriptor[] = [
  ...publicRoutes,
  ...genericWebhookRoutes,
  ...authRoutes,
  ...teamRoutes,
  ...canvasRoutes,
  ...channelRoutes,
  ...connectorRoutes,
  ...taskRoutes,
  ...projectRoutes,
  ...workspaceRoutes,
  ...workerRoutes,
  ...sessionRoutes,
  ...resourceRoutes,
  ...adminRoutes,
]
