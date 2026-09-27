import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWemuxServer } from './server.ts'

const administratorEmails = process.env.WEMUX_ADMIN_EMAILS?.trim()
if (!administratorEmails) {
  console.error([
    '缺少 WEMUX_ADMIN_EMAILS：本实例还没有管理员，启动已中止。',
    '部署者即管理员：用部署者自己的邮箱声明实例管理员（逗号分隔可声明多个），例如',
    '  WEMUX_ADMIN_EMAILS=you@example.com npm run dev:server',
    '该邮箱首次注册或登录时自动获得实例管理员权限；未声明的账号只是普通成员。',
  ].join('\n'))
  process.exit(1)
}
const databasePath = resolve(process.env.WEMUX_DATABASE_PATH ?? './data/server.sqlite')
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const workerPackagePath = resolve(process.env.WEMUX_WORKER_PACKAGE_PATH ?? resolve(repositoryRoot, 'artifacts/wemux-lite-worker.tgz'))
const webStaticPath = resolve(process.env.WEMUX_WEB_DIST ?? resolve(repositoryRoot, 'apps/web/dist'))
const servingWeb = existsSync(webStaticPath) && statSync(webStaticPath).isDirectory()
mkdirSync(dirname(databasePath), { recursive: true })
const app = createWemuxServer({ databasePath, administratorEmails, workerPackagePath, webStaticPath: servingWeb ? webStaticPath : undefined })
console.log(`Wemux Lite server listening on ${await app.listen(Number(process.env.PORT ?? 3001), process.env.HOST ?? '0.0.0.0')}${servingWeb ? ` (serving web UI from ${webStaticPath})` : ' (web UI not configured; set WEMUX_WEB_DIST or run npm run dev:web)'}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().catch(error => { console.error(error); process.exitCode = 1 }) })
