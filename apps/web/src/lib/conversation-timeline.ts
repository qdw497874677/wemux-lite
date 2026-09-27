export function parseTimelineTimestamp(timestamp: string | undefined) {
  if (!timestamp) return null
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatTimelineTime(timestamp: string | undefined) {
  const date = parseTimelineTimestamp(timestamp)
  return date ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date) : null
}

export function formatTimelineTimestampTitle(timestamp: string | undefined) {
  const date = parseTimelineTimestamp(timestamp)
  return date ? new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date) : null
}

export function timelineDayKey(timestamp: string | undefined) {
  const date = parseTimelineTimestamp(timestamp)
  if (!date) return null
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

export function formatTimelineDateLabel(timestamp: string | undefined, now = new Date()) {
  const date = parseTimelineTimestamp(timestamp)
  if (!date) return null
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayDifference = Math.round((today - day) / 86_400_000)
  if (dayDifference === 0) return '今天'
  if (dayDifference === 1) return '昨天'
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${weekday}`
}

export type TimelineDatedItem = { timestamp?: string }

export function timelineDateLabel(items: readonly TimelineDatedItem[], index: number, now = new Date()) {
  const timestamp = items[index]?.timestamp
  if (!timestamp) return null
  let previousTimestamp: string | undefined
  for (let previousIndex = index - 1; previousIndex >= 0; previousIndex--) {
    if (items[previousIndex]?.timestamp) {
      previousTimestamp = items[previousIndex].timestamp
      break
    }
  }
  return timelineDayKey(timestamp) !== timelineDayKey(previousTimestamp) ? formatTimelineDateLabel(timestamp, now) : null
}
