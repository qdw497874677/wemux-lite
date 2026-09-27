import type { DiffLineDTO } from '../../api/dto.ts'

export const MAX_DIFF_LINES = 1000
const CONTEXT_RADIUS = 3

export type VisibleDiffItem = { kind: 'line'; line: DiffLineDTO; index: number } | { kind: 'fold'; start: number; end: number }

export function buildDiffRows(lines: readonly DiffLineDTO[], expandedFolds: ReadonlySet<string>): readonly VisibleDiffItem[] {
  const visible = new Set<number>()
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]?.type === 'ctx') continue
    for (let adjacent = Math.max(0, index - CONTEXT_RADIUS); adjacent <= Math.min(lines.length - 1, index + CONTEXT_RADIUS); adjacent++) visible.add(adjacent)
  }
  const rows: VisibleDiffItem[] = []
  let index = 0
  while (index < lines.length) {
    if (visible.has(index)) {
      rows.push({ kind: 'line', line: lines[index]!, index: index++ })
      continue
    }
    const start = index
    while (index < lines.length && !visible.has(index)) index++
    const end = index
    const key = `${start}:${end}`
    if (expandedFolds.has(key)) for (let current = start; current < end; current++) rows.push({ kind: 'line', line: lines[current]!, index: current })
    else rows.push({ kind: 'fold', start, end })
  }
  return rows
}
