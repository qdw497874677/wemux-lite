import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = path => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')
const page = await source('components/account-page.tsx')
const link = await source('components/auth-link.tsx')
const client = await source('api/client.ts')
const dto = await source('api/dto.ts')
const app = await source('App.tsx')
const router = await source('app/router.tsx')

// Ticket 08 验收：绑定结果只展示一次，刷新不复现，链接被分享出去也不带别人的绑定结果。
test('link results become readable text exactly once and the address bar is cleaned', async () => {
  const { linkErrorText, readLinkError, readLinkNotice, withoutLinkParams } = await import('../src/lib/oauth-error.ts')
  assert.equal(linkErrorText(null), null)
  assert.equal(linkErrorText(''), null)
  // 绑定专属措辞（此时用户已经登录，说“登录”会让人以为账号出了问题）。
  assert.match(linkErrorText('identity_taken'), /已经绑定到本实例的另一个账号/)
  assert.match(linkErrorText('session_mismatch'), /另一个会话或账号/)
  // 登录侧已有的映射直接复用，不重复维护一份文案。
  assert.match(linkErrorText('email_conflict'), /已有账号/)
  assert.match(linkErrorText('state_expired'), /重新发起/)
  assert.equal(linkErrorText('weird_code'), 'Google 绑定未完成，请重试。')
  assert.equal(readLinkError('?link_error=identity_taken'), linkErrorText('identity_taken'))
  assert.equal(readLinkError('?linked=google'), null)
  assert.match(readLinkNotice('?linked=google'), /已绑定/)
  assert.match(readLinkNotice('?linked=google&already=1'), /没有重复绑定/)
  assert.equal(readLinkNotice('?link_error=state_expired'), '')
  assert.equal(withoutLinkParams('/settings', '?linked=google'), '/settings')
  assert.equal(withoutLinkParams('/settings', '?linked=google&already=1&tab=x'), '/settings?tab=x')
  assert.equal(withoutLinkParams('/settings', '?link_error=identity_taken'), '/settings')
  // 一次性提示：渲染后立刻 replaceState，刷新不会复现。
  assert.match(page, /window\.history\.replaceState\(null, '', withoutLinkParams\(window\.location\.pathname, window\.location\.search\)\)/)
})

// Ticket 06/08 的客户端契约：路径、方法、载荷与服务端路由逐字对齐。
test('account security client methods match the server contract', () => {
  assert.match(client, /accountSecurity: '\/api\/auth\/account\/security'/)
  assert.match(client, /authPasswordChange: '\/api\/auth\/password\/change'/)
  assert.match(client, /authEmailChange: '\/api\/auth\/email\/change'/)
  assert.match(client, /authEmailChangeConfirm: '\/api\/auth\/email\/change\/confirm'/)
  assert.match(client, /authIdentity: \(methodId: string\) => `\/api\/auth\/identities\/\$\{id\(methodId\)\}`/)
  assert.match(client, /unbindLoginMethod: \(methodId: string, body: \{ currentPassword\?: string \}\) => request<LoginMethodUnboundDTO>\(routes\.authIdentity\(methodId\), body, undefined, 'DELETE'\)/)
  assert.match(dto, /export interface PasswordChangeDTO \{ status: 'changed'; created: boolean; revokedSessions: number; revokedTokens: number \}/)
  assert.match(dto, /export interface EmailChangeAcceptedDTO \{ status: 'accepted'; email: string; expiresAt: string \}/)
  assert.match(dto, /export interface AccountSecurityViewDTO \{/)
  assert.match(dto, /removable: boolean/)
})

// 强认证判定必须在服务端：前端只能如实提示“需要当前密码”，不能自己放行。
test('password and email forms defer strong auth to the server and report the revocation they caused', () => {
  assert.match(page, /api\.changePassword\(\{ currentPassword: passwordSet \? passwordForm\.current : undefined, newPassword: passwordForm\.next \}\)/)
  assert.match(page, /api\.requestEmailChange\(\{ newEmail: emailForm\.email\.trim\(\), currentPassword: passwordSet \? emailForm\.current : undefined \}\)/)
  assert.match(page, /result\.revokedSessions/)
  assert.match(page, /result\.revokedTokens/)
  // 没有本地密码的账号不说“输入当前密码”，而是说清需要先重新登录。
  assert.match(page, /账号没有本地密码：请先用 Google 重新登录一次再操作。/)
  assert.match(page, /passwordSet \? passwordForm\.current : undefined/)
  assert.doesNotMatch(page, /fetch\(/)
  assert.doesNotMatch(page, /localStorage\.setItem\('(csrf|token)'/)
})

test('unbind stays impossible for the last remaining method and google binding degrades when unconfigured', () => {
  assert.match(page, /disabled=\{busy !== '' \|\| !method\.removable\}/)
  assert.match(page, /这是账号目前唯一的登录方式/)
  assert.match(page, /capabilities\.data\?\.google\.enabled/)
  assert.match(page, /window\.location\.assign\(started\.authorizeUrl\)/)
  // 绑定走服务端签发的授权地址，前端不拼 Google 参数。
  assert.doesNotMatch(page, /accounts\.google\.com/)
})

// Ticket 06 验收：确认链接必须由用户点击才消费，且落地页要认得这条新路径。
test('email change confirmation is a first-class landing page, not a dead link', () => {
  assert.match(link, /kind: 'verify' \| 'reset' \| 'change_email'/)
  assert.match(link, /const result = await api\.confirmEmailChange\(token\)/)
  assert.match(link, /确认更换邮箱/)
  assert.match(link, /账号邮箱已更换为 \$\{changed\.email\}/)
  assert.match(app, /window\.location\.pathname === '\/auth\/confirm-email-change' \? 'change_email' as const/)
  assert.match(router, /'\/auth\/confirm-email-change'\] as const/)
  // 邮件扫描器只 GET，不得在加载时消费令牌：落地页只有按钮触发写请求。
  assert.match(link, /本页面在加载时不会消耗它/)
})