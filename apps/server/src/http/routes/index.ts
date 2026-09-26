import { adminRoutes } from './admin-routes.js'
import { authRoutes } from './auth-routes.js'
import { canvasRoutes } from './canvas-routes.js'
import { projectRoutes } from './project-routes.js'
import { publicRoutes } from './public-routes.js'
import { resourceRoutes } from './resource-routes.js'
import { sessionRoutes } from './session-routes.js'
import { taskRoutes } from './task-routes.js'
import { teamRoutes } from './team-routes.js'
import type { RouteDescriptor } from './types.js'
import { workerRoutes } from './worker-routes.js'
import { workspaceRoutes } from './workspace-routes.js'

export const routes: readonly RouteDescriptor[] = [
  ...publicRoutes,
  ...authRoutes,
  ...teamRoutes,
  ...canvasRoutes,
  ...taskRoutes,
  ...projectRoutes,
  ...workspaceRoutes,
  ...workerRoutes,
  ...sessionRoutes,
  ...resourceRoutes,
  ...adminRoutes,
]
