import { createRootRoute, createRoute, createRouter, useBlocker } from '@tanstack/react-router'
import { useCallback, type RefObject } from 'react'
import { useConfirmDialog } from '../components/ui/confirm-dialog.tsx'
import type { HostKind } from '../hosts/bootstrap.ts'
import { clusterPaths, hostRoutes } from './host-paths.ts'
export { hostRoutes } from './host-paths.ts'

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

export const paths = clusterPaths

export function makeRouter(component: () => React.ReactNode, page: () => React.ReactNode, hostKind: HostKind = 'cluster') {
  const home = hostKind === 'local-worker' ? '/local' : '/projects'
  const root = createRootRoute({ component, errorComponent: () => <p role="alert">链接无效。<a href={home}>返回工作台</a></p>, notFoundComponent: () => <p role="alert">链接不存在。<a href={home}>返回工作台</a></p> })
  const layout = createRoute({ getParentRoute: () => root, id: 'workbench', component: page, notFoundComponent: () => <p role="alert">链接不存在。<a href={home}>返回工作台</a></p> })
  return createRouter({ routeTree: root.addChildren([layout.addChildren(hostRoutes(hostKind).map(path => createRoute({ getParentRoute: () => layout, path, component: () => null })))]), defaultPreload: false })
}
