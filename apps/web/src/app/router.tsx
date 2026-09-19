import { createRootRoute, createRoute, createRouter, useBlocker } from '@tanstack/react-router'
import { useCallback, type RefObject } from 'react'

/** All router navigation (links, imperative navigation and history POP) shares this boundary. */
export function useTaskNavigationGuard(dirty: RefObject<boolean>) {
  useBlocker({
    shouldBlockFn: useCallback(({ current, next }) => dirty.current && (current.pathname !== next.pathname || JSON.stringify(current.search) !== JSON.stringify(next.search)) && !window.confirm('放弃未保存的修改？'), [dirty]),
    enableBeforeUnload: useCallback(() => dirty.current, [dirty]),
  })
}

export const paths = ['/', '/projects', '/projects/$projectId', '/projects/$projectId/overview', '/projects/$projectId/board', '/projects/$projectId/tasks', '/projects/$projectId/tasks/$taskId', '/projects/$projectId/activity', '/projects/$projectId/settings', '/projects/$projectId/workspaces', '/projects/$projectId/workspaces/$workspaceId', '/projects/$projectId/sessions', '/projects/$projectId/sessions/$sessionId', '/runtime', '/runtimes', '/cluster', '/components', '/settings', '/auth/verify-email', '/auth/password/reset', '/auth/confirm-email-change'] as const
export function makeRouter(component: () => React.ReactNode, page: () => React.ReactNode) {
  const root = createRootRoute({ component, errorComponent: () => <p role="alert">链接无效。<a href="/projects">返回项目列表</a></p>, notFoundComponent: () => <p role="alert">链接不存在。<a href="/projects">返回项目列表</a></p> })
  const layout = createRoute({ getParentRoute: () => root, id: 'workbench', component: page })
  return createRouter({ routeTree: root.addChildren([layout.addChildren(paths.map(path => createRoute({ getParentRoute: () => layout, path, component: () => null })))]), defaultPreload: false })
}
