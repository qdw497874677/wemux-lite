import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const landingSource = await readFile(new URL('../src/components/landing.tsx', import.meta.url), 'utf8')
const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const stylesSource = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')

test('landing screen is a page-level inline connect form, not a modal', () => {
  assert.match(landingSource, /export function LandingScreen\(\{ config, onSave \}/)
  assert.doesNotMatch(landingSource, /Dialog|DialogPortal|modal/)
  assert.match(appSource, /: <LandingScreen config=\{config\} onSave=\{applyConnection\} \/>/)
  // 应用内重连仍走 ConnectionDialog，首屏连接不再依赖弹窗。
  assert.match(appSource, /\{settings && <ConnectionDialog config=\{config\} onClose=\{\(\) => setSettings\(false\)\} onSave=\{applyConnection\} \/>/)
})

test('landing connect flow keeps token semantics and error handling of the dialog', () => {
  assert.match(landingSource, /const session = await api\.createAdminSession\(\)/)
  assert.match(landingSource, /onSave\(\{ token: session\.token, teamId: session\.teamId, expiresAt: session\.expiresAt \}\)/)
  assert.match(landingSource, /管理员令牌无效，请确认它与服务端的 WEMUX_BOOTSTRAP_TOKEN 一致。/)
  assert.match(landingSource, /无法连接服务端：\$\{message\}/)
  assert.match(landingSource, /token\.trim\(\)\.length < 16/)
  assert.match(landingSource, /管理员令牌长度不足/)
  assert.match(landingSource, /aria-label=\{showToken \? '隐藏管理员令牌' : '显示管理员令牌'\}/)
  assert.match(landingSource, /autoFocus/)
  assert.match(landingSource, /role="alert"/)
  assert.match(landingSource, /aria-labelledby="landing-title"/)
  assert.match(landingSource, /WEMUX_BOOTSTRAP_TOKEN/)
  assert.match(landingSource, /访问令牌默认有效 7 天/)
  assert.match(landingSource, /HTTP 明文连接/)
})

test('landing layout is an asymmetric split that collapses on narrow viewports', () => {
  assert.match(stylesSource, /\.landing-grid \{ display: grid; grid-template-columns: minmax\(0, 1fr\) min\(400px, 100%\)/)
  assert.match(stylesSource, /@media \(max-width: 1023px\) \{[\s\S]*?\.landing-grid \{ grid-template-columns: minmax\(0, 1fr\);/)
  assert.match(stylesSource, /\.landing-root \{ height: 100dvh; overflow-y: auto/)
})
