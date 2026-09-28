export function groupByKey<T>(items: readonly T[], key: (item: T) => string): readonly [string, readonly T[]][] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const groupKey = key(item), group = groups.get(groupKey)
    if (group) group.push(item)
    else groups.set(groupKey, [item])
  }
  return [...groups.entries()]
}
