import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import test from 'node:test'

const landingSource = await readFile(new URL('../src/components/landing.tsx', import.meta.url), 'utf8')
const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const clientSource = await readFile(new URL('../src/api/client.ts', import.meta.url), 'utf8')
const stylesSource = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
const authFormSource = await readFile(new URL('../src/components/auth-form.tsx', import.meta.url), 'utf8')

test('landing screen is a page-level inline form, not a modal', () => {
  assert.match(landingSource, /export function LandingScreen\(\{ notice, onAuthenticated \}/)
  assert.doesNotMatch(landingSource, /Dialog|DialogPortal|modal/)
  assert.match(appSource, /: <LandingScreen notice=\{notice\} onAuthenticated=\{applyAccount\} \/>/)
  // 应用内重新认证仍走 ConnectionDialog，首屏不再依赖弹窗。
  assert.match(appSource, /\{signedIn && settings && <ConnectionDialog session=\{config\} expired=\{expired\}/)
})

test('落地表单没有引导令牌入口：直接登录或注册', () => {
  assert.match(landingSource, /const value = await api\.authOptions\(\)/)
  assert.match(landingSource, /const \[mode, setMode\] = useState<AuthMode>\('login'\)/)
  assert.match(landingSource, /const minimumLength = registration\?\.passwordMinimumLength \?\? options\?\.passwordMinimumLength \?\? 15/)
  assert.match(landingSource, /<AuthForm mode=\{mode\} minimumLength=\{minimumLength\}/)
  assert.match(landingSource, /本实例未声明管理员邮箱，无法登录控制台。请重启服务端并设置 WEMUX_ADMIN_EMAILS/)
  assert.match(landingSource, /本实例的管理员已由部署声明，但对应账号还没建立/)
  assert.match(authFormSource, /await api\.login\(login\.trim\(\), password\)/)
  assert.match(landingSource, /role="alert"/)
  assert.match(landingSource, /aria-labelledby="landing-title"/)
  assert.match(landingSource, /HTTP 明文连接/)
  // 首屏不再要求粘贴长期令牌。
  assert.doesNotMatch(landingSource, /访问令牌默认有效/)
  // 引导令牌与认领表单必须彻底消失：授权根是启动配置里声明的管理员邮箱。
  assert.doesNotMatch(landingSource, /bootstrapToken|setupAccount|claimed/)
  assert.doesNotMatch(authFormSource, /bootstrapToken|setupAccount|WEMUX_BOOTSTRAP_TOKEN|'setup'/)
  assert.doesNotMatch(clientSource, /setupAccount|authSetup/)
})

// Ticket 05：自助注册与找回只在实例开放且邮件可用时出现，且直连 API 的策略是权威的。
test('self-service registration follows instance policy and mail availability', async () => {
  const authLinkSource = await readFile(new URL('../src/components/auth-link.tsx', import.meta.url), 'utf8')
  assert.match(landingSource, /const registration = options\?\.registration \?\? null/)
  assert.match(landingSource, /registrationPolicy === 'invite_only'[\s\S]{0,200}部署时声明的管理员邮箱是例外，可直接注册或登录/)
  assert.match(landingSource, /'本实例目前只允许邀请注册，请联系实例管理员。'/)
  assert.match(landingSource, /registrationPolicy === 'closed' \? '本实例已关闭注册。' : ''/)
  assert.match(landingSource, /!registration\.emailDelivery && !closedReason/)
  assert.match(landingSource, /自助注册与找回密码暂时无法使用/)
  assert.match(landingSource, /还没有账号？用邮箱注册/)
  // 声明邮箱还没建号时（默认仅邀请策略），注册入口必须仍然可达：否则第一次启动的实例无法自举，
  // 而服务端本来就豁免声明邮箱，这是界面与权威策略不一致的死路。
  assert.match(landingSource, /const declaredFirstRun = administratorUnregistered && registration\?\.emailDelivery === true/)
  assert.match(landingSource, /registration\.registrationPolicy === 'open' \|\| declaredFirstRun/)
  assert.match(authFormSource, /api\.register\(\{ email: email\.trim\(\)/)
  assert.match(authFormSource, /api\.forgotPassword\(email\.trim\(\)\)/)
  assert.match(authFormSource, /api\.resendVerification\(sent\.email\)/)
  // 验证与重置链接在未登录时也必须可打开：不能自动消费凭据（邮件扫描器只做 GET）。
  assert.match(appSource, /import \{ AuthLinkScreen, readLinkToken \} from '\.\/components\/auth-link'/)
  assert.match(appSource, /linkKind && !signedIn \? <AuthLinkScreen kind=\{linkKind\}/)
  assert.match(authLinkSource, /export function AuthLinkScreen/)
  assert.match(authLinkSource, /api\.verifyEmail\(token\)/)
  assert.match(authLinkSource, /api\.resetPassword\(token, password\)/)
  assert.doesNotMatch(authLinkSource, /useEffect\([\s\S]{0,200}(verifyEmail|resetPassword)/, '加载页面不得自动消费一次性令牌')
  assert.match(authLinkSource, /export function readLinkToken\(search: string\): string/)
  // 令牌只随这一次请求发送，不写入任何浏览器存储。
  assert.doesNotMatch(authLinkSource, /localStorage|sessionStorage|document\.cookie/)
})

test('credentials live in HttpOnly cookies: no token storage in the browser', async () => {
  const transport = await readFile(new URL('../../../packages/web-client/src/cluster-transport.ts', import.meta.url), 'utf8')
  const contract = await readFile(new URL('../../../packages/web-contract/src/browser-host.ts', import.meta.url), 'utf8')
  assert.match(clientSource, /const transport = createClusterTransport\(config, onUnauthorized\)/)
  assert.match(clientSource, /const \{ request, list, unauthorized, setCsrfToken \} = transport/)
  assert.match(clientSource, /export type \{ AccountSession \} from '@wemux\/web-contract\/browser-host'/)
  const clientSourceChecked = `${clientSource}\n${transport}\n${contract}`
  assert.ok(!clientSourceChecked.includes('localStorage.setItem'))
  assert.match(clientSourceChecked, /credentials: 'same-origin'/)
  assert.match(clientSourceChecked, /headers\['X-CSRF-Token'\] = csrfToken/)
  assert.match(clientSourceChecked, /export interface AccountSession \{ teamId: string; csrfToken: string; username: string; email: string \| null; instanceAdministrator: boolean \}/)
  assert.ok(!existsSync(new URL('../src/lib/connection-storage.ts', import.meta.url)), '连接令牌存储模块应已删除')
  const deviceScope = await readFile(new URL('../src/lib/device-scope.ts', import.meta.url), 'utf8')
  assert.match(deviceScope, /export const legacyConnectionKey = 'wemux\.connection'/)
  assert.match(deviceScope, /export function retireLegacyCredentials/)
  assert.match(appSource, /const retired = retireLegacyCredentials\(\)/)
  assert.match(appSource, /const account = await api\.currentAccount\(\)/)
})

test('landing layout is an asymmetric split that collapses on narrow viewports', () => {
  assert.match(stylesSource, /\.landing-grid \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) min\(400px, 100%\)/)
  assert.match(stylesSource, /@media \(max-width: 1023px\) \{[\s\S]*?\.landing-grid \{ grid-template-columns: minmax\(0, 1fr\);/)
  assert.match(stylesSource, /\.landing-root \{[^}]*height: 100dvh;[^}]*overflow-y: auto/)
})