import type { CommandStatus, RuntimeState, WorkspaceDTO } from '@/api/dto'

export const workerStateLabel = {
  online: '在线',
  offline: '离线',
  revoked: '已撤销',
} as const

export const workspaceStateLabel: Record<WorkspaceDTO['status'], string> = {
  ready: '运行中',
  stopped: '已停止',
  deleted: '已删除',
  failed: '创建失败',
  unhealthy: '不健康',
}

export const runtimeStateLabel: Record<RuntimeState, string> = {
  idle: '空闲',
  queued: '等待执行',
  running: '运行中',
  stopping: '正在停止',
  unavailable: '不可用',
  failed: '运行失败',
}

export const commandStateLabel: Record<CommandStatus, string> = {
  pending: '等待下发',
  accepted: '已接收',
  rejected: '已拒绝',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

type DateValue = string | number | Date | null | undefined

function validTimestamp(value: DateValue): number | null {
  if (value === null || value === undefined || value === '') return null
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

export function formatChineseTime(value: DateValue): string {
  const timestamp = validTimestamp(value)
  if (timestamp === null) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(timestamp))
}

export function formatRelativeTime(value: DateValue, now = Date.now()): string {
  const timestamp = validTimestamp(value)
  if (timestamp === null) return '时间未知'
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)} 天前`
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(timestamp))
}
