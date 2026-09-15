import type { CommandStatus, RuntimeState, WorkspaceDTO } from '@/api/dto'

export const workerStateLabel = {
  online: '在线',
  offline: '离线',
  revoked: '已撤销',
} as const

export const workspaceStateLabel: Record<WorkspaceDTO['status'], string> = {
  pending: '等待处理',
  provisioning: '正在初始化',
  ready: '已就绪',
  failed: '初始化失败',
  deleting: '正在删除',
  deleted: '已删除',
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

export function formatChineseTime(value: string | number | Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value))
}
