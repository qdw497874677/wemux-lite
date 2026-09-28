import { createRootRoute, createRoute, createRouter, useBlocker } from '@tanstack/react-router'
import { useCallback, type RefObject } from 'react'
import { useConfirmDialog } from '../components/ui/confirm-dialog.tsx'

/** All router navigation (links, imperative navigation and history POP) shares this boundary. */
export function useTaskNavigationGuard(dirty: RefObject<boolean>) {
  const confirm = useConfirmDialog()
  useBlocker({
    shouldBlockFn: useCallback(async ({ current, next }) => {
      if (!dirty.current || (current.pathname === next.pathname && JSON.stringify(current.search) === JSON.stringify(next.search))) return false
      return !await confirm({ title: '放弃未保存的修改', description: '当前页面有尚未保存的修改。确认离开并放弃这些修改？', confirmLabel: '放弃修改', danger: true })
    }, [confirm, dirty]),
    enableBeforeUnload: useCallback(() => dirty.current, [dirty]),
  })
}

export const paths = ['/', '/attention', '/approvals', '/timeline', '/projects', '/projects/$projectId', '/projects/$projectId/overview', '/projects/$projectId/canvas', '/projects/$projectId/board', '/projects/$projectId/tasks', '/projects/$projectId/tasks/$taskId', '/projects/$projectId/activity', '/projects/$projectId/connectors', '/projects/$projectId/channels', '/projects/$projectId/settings', '/projects/$projectId/workspaces', '/projects/$projectId/workspaces/$workspaceId', '/projects/$projectId/sessions', '/projects/$projectId/sessions/$sessionId', '/runtime', '/runtimes', '/cluster', '/teams', '/components', '/settings', '/join', '/auth/verify-email', '/auth/password/reset', '/auth/confirm-email-change'] as const
export function makeRouter(component: () => React.ReactNode, page: () => React.ReactNode) {
  const root = createRootRoute({ component, errorComponent: () => <p role="alert">链接无效。<a href="/projects">返回项目列表</a></p>, notFoundComponent: () => <p role="alert">链接不存在。<a href="/projects">返回项目列表</a></p> })
  const layout = createRoute({ getParentRoute: () => root, id: 'workbench', component: page, notFoundComponent: page })
  return createRouter({ routeTree: root.addChildren([layout.addChildren(paths.map(path => createRoute({ getParentRoute: () => layout, path, component: () => null })))]), defaultPreload: false })
}
