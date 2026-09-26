import { BaseEdge, getBezierPath, getSimpleBezierPath, type EdgeProps } from '@xyflow/react'

function Temporary({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style }: EdgeProps) {
  const [path] = getSimpleBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ ...style, strokeDasharray: '5 5' }} />
}

function Animated({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style }: EdgeProps) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
    <circle className="fill-primary" r="3.5"><animateMotion dur="2s" path={path} repeatCount="indefinite" /></circle>
  </>
}

export const Edge = { Animated, Temporary }
