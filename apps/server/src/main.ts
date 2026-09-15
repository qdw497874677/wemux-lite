import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWemuxServer } from './server.js'

const bootstrapToken = process.env.WEMUX_BOOTSTRAP_TOKEN
if (!bootstrapToken) throw new Error('Set WEMUX_BOOTSTRAP_TOKEN (at least 16 characters)')
const databasePath = resolve(process.env.WEMUX_DATABASE_PATH ?? './data/server.sqlite')
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const workerPackagePath = resolve(process.env.WEMUX_WORKER_PACKAGE_PATH ?? resolve(repositoryRoot, 'artifacts/wemux-lite-worker.tgz'))
const webStaticPath = resolve(process.env.WEMUX_WEB_DIST ?? resolve(repositoryRoot, 'apps/web/dist'))
const servingWeb = existsSync(webStaticPath) && statSync(webStaticPath).isDirectory()
mkdirSync(dirname(databasePath), { recursive: true })
const app = createWemuxServer({ databasePath, bootstrapToken, workerPackagePath, webStaticPath: servingWeb ? webStaticPath : undefined })
console.log(`Wemux Lite server listening on ${await app.listen(Number(process.env.PORT ?? 3001), process.env.HOST ?? '127.0.0.1')}${servingWeb ? ` (serving web UI from ${webStaticPath})` : ' (web UI not configured; set WEMUX_WEB_DIST or run npm run dev:web)'}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().catch(error => { console.error(error); process.exitCode = 1 }) })
