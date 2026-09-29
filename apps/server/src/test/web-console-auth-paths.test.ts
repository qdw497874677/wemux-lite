import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WEB_CONSOLE_AUTH_PATHS, isWebConsoleAuthPath } from '../application/web-console-routes.js'
import { changeEmailLink, passwordResetLink, verificationLink } from '../application/mail/email-delivery.js'

// Ticket 06 的真实回归：邮箱变更链接按 Server 的 `WEB_CONSOLE_AUTH_PATHS` 生成，Web 的落地页判定却写着
// `/auth/email/change/confirm`。两边各自都“有测试”，但没人比对过这两份清单，于是用户点开邮件只会看到
// API 命名空间的 404（或者干脆什么都没有）。这里把「邮件链接 → 页面路径 → 路由清单」串起来锁死。
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

test('邮件里的三个链接都落在 Web 控制台自己渲染的路径上', () => {
  const links = [verificationLink, passwordResetLink, changeEmailLink].map(build => new URL(build('https://wemux.example/', 'token-value')))
  for (const link of links) {
    assert.equal(link.origin, 'https://wemux.example')
    assert.equal(link.searchParams.get('token'), 'token-value')
    assert.equal(isWebConsoleAuthPath(link.pathname), true, `${link.pathname} 必须由 Web 控制台渲染，否则用户点开邮件只会看到 API 404`)
  }
  assert.equal(new Set(links.map(link => link.pathname)).size, links.length, '三个链接必须各占一个页面，不能互相串用')
  // API 命名空间里的路径不能同时当页面用：`/auth/email/change/confirm` 是写接口，不是落地页。
  assert.equal(isWebConsoleAuthPath('/auth/email/change/confirm'), false)
})

test('Web 路由清单与 Server 声明的控制台路径逐个一致', async () => {
  const [router, app] = await Promise.all([
    readFile(resolve(repositoryRoot, 'apps/web/src/app/host-paths.ts'), 'utf8'),
    readFile(resolve(repositoryRoot, 'apps/web/src/App.tsx'), 'utf8'),
  ])
  for (const path of Object.values(WEB_CONSOLE_AUTH_PATHS)) {
    assert.ok(router.includes(`'${path}'`), `apps/web/src/app/host-paths.ts 的 clusterPaths 缺少 ${path}`)
    assert.ok(app.includes(`'${path}'`), `apps/web/src/App.tsx 的链接落地页判定缺少 ${path}`)
  }
})