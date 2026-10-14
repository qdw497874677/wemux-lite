import type {
  AuthenticationStateDTO, ConfigurationStateDTO, DistributionStateDTO, ExecutionStateDTO, ResourceInventoryClassDTO,
} from '@wemux/web-contract/browser-host'

/** 四态的中文标签。四条轴各自命名，任何一条都不得借用另一条的结论。 */
export const configurationLabels: Readonly<Record<ConfigurationStateDTO, string>> = { configured: '已配置', unconfigured: '未配置' }
export const authenticationLabels: Readonly<Record<AuthenticationStateDTO, string>> = {
  authenticated: '已认证', unauthenticated: '未认证', unknown: '认证未知', 'not-required': '无需认证',
}
export const distributionLabels: Readonly<Record<DistributionStateDTO, string>> = {
  distributed: '已分发', pending: '分发待确认', failed: '分发失败', 'not-distributed': '未分发',
}
export const executionLabels: Readonly<Record<ExecutionStateDTO, string>> = {
  executable: '可执行', unavailable: '不可执行', unknown: '执行未知', 'not-applicable': '不直接执行',
}
export const classLabels: Readonly<Record<ResourceInventoryClassDTO, string>> = {
  worker: '工作节点', agent: 'Agent', model: '模型', skill: '技能', preset: '预设', provider: 'Provider',
}
export const axisLabels = ['configuration', 'authentication', 'distribution', 'execution'] as const
export type InventoryAxisName = typeof axisLabels[number]
export const axisTitles: Readonly<Record<InventoryAxisName, string>> = {
  configuration: '已配置', authentication: '已认证', distribution: '已分发', execution: '可执行',
}

/**
 * 探测证据时间。没有 observedAt 的轴必须显式声明“无探测证据”，
 * 否则界面会把 Server 的声明读成实时事实。
 */
export function observation(observedAt: string | null, fallback = '无探测证据'): string {
  return observedAt === null ? fallback : `探测于 ${new Date(observedAt).toLocaleString('zh-CN')}`
}
