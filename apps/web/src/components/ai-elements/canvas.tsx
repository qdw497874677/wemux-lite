import '@xyflow/react/dist/style.css'
import { Background, ReactFlow, type Edge, type Node, type ReactFlowProps } from '@xyflow/react'
import type { ReactNode } from 'react'

export type CanvasProps<NodeType extends Node = Node, EdgeType extends Edge = Edge> = ReactFlowProps<NodeType, EdgeType> & { readonly children?: ReactNode }

export function Canvas<NodeType extends Node = Node, EdgeType extends Edge = Edge>({ children, ...props }: CanvasProps<NodeType, EdgeType>) {
  return <ReactFlow<NodeType, EdgeType> deleteKeyCode={null} fitView panOnScroll selectionOnDrag zoomOnDoubleClick={false} {...props}>
    <Background bgColor="var(--background)" color="var(--border)" gap={24} size={1} />
    {children}
  </ReactFlow>
}
