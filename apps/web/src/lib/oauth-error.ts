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

/**
 * 绑定流程专用措辞：同一条回调链路，但用户此刻已经登录，说“登录”会让人以为把账号弄丢了。
 * 登录侧已有的映射不重复写，靠下面的回退共享。
 */
const linkMessages: Record<string, string> = {
  session_required: '绑定必须在发起它的已登录浏览器里完成。请重新登录后再点绑定。',
  session_mismatch: '这次绑定是在另一个会话或账号里发起的，换回原来的窗口重试。',
  identity_taken: '这个 Google 账号已经绑定到本实例的另一个账号；先在那个账号上解绑，或换一个 Google 账号。',
  intent_mismatch: '这次跳转不属于绑定流程，请重新点击「绑定 Google 登录」。',
}

/** 绑定回调的结果码转人话；未知码也给下一步（Ticket 08）。 */
export function linkErrorText(code: string | null | undefined): string | null {
  if (typeof code !== 'string' || code.length === 0) return null
  return linkMessages[code] ?? messages[code] ?? 'Google 绑定未完成，请重试。'
}

/** 从查询串读取 `link_error`（绑定失败）。 */
export function readLinkError(search: string): string | null {
  return linkErrorText(new URLSearchParams(search.startsWith('?') ? search : `?${search}`).get('link_error'))
}

/**
 * 从查询串读取绑定成功标记。`already=1` 是幂等语义：点两次绑定不该被当成出错。
 * 返回空串表示没有绑定结果，调用方不渲染横幅。
 */
export function readLinkNotice(search: string): string {
  const query = new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
  if (query.get('linked') !== 'google') return ''
  return query.get('already') === '1'
    ? '这个 Google 账号本来就绑定在当前账号上，没有重复绑定。'
    : 'Google 登录已绑定：现在可以用它登录这个账号。'
}

/** 去掉绑定结果参数后的地址：提示只展示一次，刷新不再复现，也不会被误分享出去。 */
export function withoutLinkParams(pathname: string, search: string): string {
  const query = new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
  query.delete('linked')
  query.delete('already')
  query.delete('link_error')
  const rest = query.toString()
  return rest.length === 0 ? pathname : `${pathname}?${rest}`
}

/** 去掉 `oauth_error` 后的地址：错误提示只展示一次，刷新页面不再复现。 */
export function withoutOauthError(pathname: string, search: string): string {
  const query = new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
  query.delete('oauth_error')
  const rest = query.toString()
  return rest.length === 0 ? pathname : `${pathname}?${rest}`
}