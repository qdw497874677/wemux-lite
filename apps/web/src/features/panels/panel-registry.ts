/* Derived from pingdotgg/t3code (MIT). */
import type { ComponentType, ReactNode } from 'react'

export interface PanelRenderContext {
  sessionId: string
}

export interface PanelDescriptor<Context extends PanelRenderContext = PanelRenderContext> {
  id: string
  icon: ComponentType<{ className?: string }>
  title: string
  render: (context: Context) => ReactNode
  keepAlive?: boolean
}

export function createPanelRegistry<Context extends PanelRenderContext>(descriptors: readonly PanelDescriptor<Context>[]) {
  const byId = new Map(descriptors.map(descriptor => [descriptor.id, descriptor]))
  return {
    descriptors,
    get: (id: string) => byId.get(id),
    first: () => descriptors[0],
  }
}
