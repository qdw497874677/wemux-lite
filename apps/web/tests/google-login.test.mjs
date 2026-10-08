import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = (path) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')
const landing = await source('components/landing.tsx')
const authForm = await source('components/auth-form.tsx')
const dialog = await source('components/connection-dialog.tsx')
const client = await source('api/client.ts')
const legacyDto = await source('api/dto.ts')
const sharedDto = await readFile(new URL('../../../packages/web-contract/src/browser-host.ts', import.meta.url), 'utf8')
const dto = `${legacyDto}\n${sharedDto}`
assert.match(legacyDto, /export type \{[^}]+GoogleCapabilityDTO[^}]*\} from '@wemux\/web-contract\/browser-host'/)

// Ticket 07 验收：未配置 Provider 时不出现能点但必然失败的 Google 入口。
test('google button only renders when the instance reports the provider as configured', () => {
  assert.match(dto, /export interface GoogleCapabilityDTO \{ enabled: boolean; reason: string \| null \}/)
  assert.match(dto, /registration: RegistrationCapabilitiesDTO \| null; google: GoogleCapabilityDTO \}/)
  assert.match(landing, /google=\{options\.google\}/)
  assert.match(authForm, /\{mode === 'login' && google\?\.enabled && <>/)
  // 未配置时不渲染按钮：能力清单是唯一开关，不看环境变量也不猜。
  assert.doesNotMatch(authForm, /WEMUX_GOOGLE/)
})

test('google sign-in starts from the server contract and returns to the current address', () => {
  assert.match(client, /authGoogleStart: '\/api\/auth\/oauth\/google\/start'/)
  assert.match(client, /startGoogleSignIn: \(returnTo\?: string\) => request<\{ authorizeUrl: string; expiresAt: string \}>\(routes\.authGoogleStart, returnTo \? \{ returnTo \} : \{\}\)/)
  assert.match(authForm, /const started = await api\.startGoogleSignIn\(`\$\{window\.location\.pathname\}\$\{window\.location\.search\}`\)/)
  // 授权页由服务端决定，前端只做整页跳转，不在页面里拼 Google 参数。
  assert.match(authForm, /window\.location\.assign\(started\.authorizeUrl\)/)
  assert.doesNotMatch(authForm, /accounts\.google\.com/)
})

// 会话过期弹窗里的重新登录同样要有 Google：纯 Google 账号没有本地密码，只给密码表单会把人困住。
test('in-app re-authentication also offers google and degrades to password when probing fails', () => {
  assert.match(dialog, /void api\.authOptions\(\)\.then\(value => \{ if \(active\) setOptions\(value\) \}\)\.catch\(\(\) => \{ if \(active\) setOptions\(null\) \}\)/)
  assert.match(dialog, /<AuthForm mode="login" google=\{options\?\.google\} submitLabel="登录"/)
})

test('oauth callback errors are translated once and never leave the raw code in the address bar', async () => {
  const { oauthErrorText, readOauthError, withoutOauthError } = await import('../src/lib/oauth-error.ts')
  assert.equal(oauthErrorText(null), null)
  assert.equal(oauthErrorText(''), null)
  assert.match(oauthErrorText('email_conflict'), /已有账号/)
  assert.match(oauthErrorText('registration_closed'), /关闭新账号注册/)
  assert.match(oauthErrorText('invitation_required'), /仅限邀请注册/)
  assert.match(oauthErrorText('google_unavailable'), /稍后重试/)
  assert.match(oauthErrorText('state_replayed'), /重新发起/)
  // 未知码也要给人话与下一步，不能把原始码直接丢给用户。
  assert.equal(oauthErrorText('weird_code'), 'Google 登录未完成，请重试或改用账号密码。')
  assert.equal(readOauthError('?oauth_error=email_conflict'), oauthErrorText('email_conflict'))
  assert.equal(readOauthError('?foo=1'), null)
  assert.equal(withoutOauthError('/projects/ada', '?oauth_error=email_conflict&tab=tasks'), '/projects/ada?tab=tasks')
  assert.equal(withoutOauthError('/projects/ada', '?oauth_error=email_conflict'), '/projects/ada')
  assert.match(landing, /window\.history\.replaceState\(null, '', withoutOauthError\(window\.location\.pathname, window\.location\.search\)\)/)
  assert.match(landing, /\{oauthError && <p role="alert"/)
})