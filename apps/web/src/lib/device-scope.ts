import { randomId } from './random.ts'

/**
 * 设备（浏览器）本地标识：只用于本地草稿的启动身份与查询作用域，**不是凭据**。
 * Ticket 04 起认证完全交给 HttpOnly Cookie 会话，浏览器不再保存任何令牌。
 */
export const deviceScopeKey = 'wemux.device'
/** Ticket 04 之前的长期凭据键（含管理员令牌与代理令牌），启动时明确退役。 */
export const legacyConnectionKey = 'wemux.connection'

type ReadWriteStorage = Pick<Storage, 'getItem' | 'setItem'>
type ReadOnlyStorage = Pick<Storage, 'getItem' | 'removeItem'>

/** 读取稳定设备标识；storage 不可用（隐私模式/禁用）时退化为进程内随机值。 */
export function readDeviceId(storage: ReadWriteStorage = window.localStorage, mint = randomId): string {
  try {
    const existing = storage.getItem(deviceScopeKey)
    if (existing) return existing
    const fresh = mint()
    storage.setItem(deviceScopeKey, fresh)
    return fresh
  } catch {
    return mint()
  }
}

/**
 * 删除旧版本保存在 localStorage 里的访问令牌。返回是否真的清除了历史凭据，
 * 调用方据此提示用户“需要重新登录”，而不是静默失败。
 */
export function retireLegacyCredentials(storage: ReadOnlyStorage = window.localStorage): boolean {
  try {
    if (!storage.getItem(legacyConnectionKey)) return false
    storage.removeItem(legacyConnectionKey)
    return true
  } catch {
    return false
  }
}