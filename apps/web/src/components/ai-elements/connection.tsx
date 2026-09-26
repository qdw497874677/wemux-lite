import type { ConnectionLineComponent } from '@xyflow/react'

export const Connection: ConnectionLineComponent = ({ fromX, fromY, toX, toY }) => {
  const middleX = fromX + (toX - fromX) * 0.5
  return <g>
    <path className="animated" d={`M${fromX},${fromY} C ${middleX},${fromY} ${middleX},${toY} ${toX},${toY}`} fill="none" stroke="var(--primary)" strokeWidth={1} />
    <circle cx={toX} cy={toY} fill="var(--background)" r={3} stroke="var(--primary)" strokeWidth={1} />
  </g>
}
