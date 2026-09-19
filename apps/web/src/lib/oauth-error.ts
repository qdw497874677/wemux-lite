/**
 * Google 回调把错误码放在跳转地址上（`/?oauth_error=...`），这里把它翻译成人话。
 * 只做映射，不碰网络；映射表覆盖服务端所有可能错误码，未知码也必须给出可理解的下一步。
 */
const messages: Record<string, string> = {
  google_unconfigured: '本实例未配置 Google 登录，请使用账号密码。',
  google_verification_failed: 'Google 身份校验失败，本次登录已中止。请重新发起登录。',
  google_unavailable: 'Google 令牌交换失败，可能是网络或 Google 侧暂时故障。请稍后重试。',
  email_conflict: '该邮箱在本实例已有账号。请先用原有方式登录，再到账号安全设置里绑定 Google。',
  registration_closed: '本实例已关闭新账号注册；Google 登录仅对已有账号可用。',
  invitation_required: '本实例仅限邀请注册。请先通过团队邀请创建账号，再用 Google 登录。',
  invalid_state: '登录状态缺失或已过期，请重新发起 Google 登录。',
  state_mismatch: '登录状态与发起登录的浏览器不一致，请在同一浏览器里重新发起 Google 登录。',
  state_replayed: '该登录状态已被使用，请重新发起 Google 登录。',
  state_expired: '登录状态已过期，请重新发起 Google 登录。',
  intent_mismatch: '该登录状态不属于登录流程，请重新发起 Google 登录。',
  invalid_request: 'Google 回调缺少必要参数，请重新发起 Google 登录。',
  identity_orphaned: '该 Google 身份绑定的账号已不存在，请联系实例管理员。',
}

/** 返回可展示的错误文案；没有错误码时返回 null（调用方不渲染横幅）。 */
export function oauthErrorText(code: string | null | undefined): string | null {
  if (typeof code !== 'string' || code.length === 0) return null
  return messages[code] ?? 'Google 登录未完成，请重试或改用账号密码。'
}

/** 从查询串读取 `oauth_error`；保留未知码本身作为反馈线索，不静默吞掉。 */
export function readOauthError(search: string): string | null {
  const code = new URLSearchParams(search.startsWith('?') ? search : `?${search}`).get('oauth_error')
  return oauthErrorText(code)
}

/** 去掉 `oauth_error` 后的地址：错误提示只展示一次，刷新页面不再复现。 */
export function withoutOauthError(pathname: string, search: string): string {
  const query = new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
  query.delete('oauth_error')
  const rest = query.toString()
  return rest.length === 0 ? pathname : `${pathname}?${rest}`
}