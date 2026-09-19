import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Ticket 04 验收项 3 的边界回归：Server 与 Worker 不共享账号数据库。
 * Worker 可以独立安装并用自己的本地管理凭据服务 `/api/local/*`，
 * 但它不得读取或冒充 Server 的账号记录（本地凭据、登录会话、实例认领），
 * 也不得以 Server 的 `/auth/*` 入口作为自己的登录方式。
 */
const workerRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')

async function sources(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return await sources(path)
    return entry.name.endsWith('.ts') ? [path] : []
  }))
  return files.flat()
}

const serverAccountMarkers = [
  ['Server 本地凭据记录', /'local-credential'|"local-credential"/],
  ['Server 登录会话表', /login_sessions/],
  ['Server 实例认领记录', /instance_claim/],
  ['Server 登录 Cookie 名', /wemux_login_session/],
  ['Server 认领入口', /['"]\/auth\/setup['"]/],
  ['Server 登录入口', /['"]\/auth\/login['"]/],
  ['Server 当前账号入口', /['"]\/auth\/me['"]/],
] as const

test('Worker 源码不引用 Server 账号记录与 Server 登录入口', async () => {
  const files = await sources(join(workerRoot, 'src'))
  assert.ok(files.length > 20, `预期扫描到 Worker 源码，实际 ${files.length} 个文件`)
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const [label, pattern] of serverAccountMarkers) {
      assert.ok(!pattern.test(text), `${file} 不得引用${label}`)
    }
  }
})

test('Worker 本地控制面只服务 /api/local/*，本地会话不等同 Server 登录会话', async () => {
  const server = await readFile(join(workerRoot, 'src/local-control/server.ts'), 'utf8')
  for (const route of ['/auth/login', '/auth/setup', '/auth/me', '/auth/logout', '/auth/sessions']) {
    assert.ok(!server.includes(`'${route}'`) && !server.includes(`"${route}"`), `Worker 本地控制面不得提供 ${route}`)
  }
  // 允许的写法是 Worker 自己的本地管理会话：必须带 /api/local 前缀。
  for (const match of server.matchAll(/['"`](\/[^'"`]*\/auth\/session)['"`]/g)) {
    assert.ok(match[1]!.startsWith('/api/local/'), `本地会话入口必须以 /api/local 开头，实际 ${match[1]}`)
  }
  assert.match(server, /\/api\/local\/auth\/session/)
})

test('Worker 生产依赖不引入 Server 包，账号库天然不共享', async () => {
  const pkg = JSON.parse(await readFile(join(workerRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })
  assert.deepEqual(declared.filter(name => name === '@wemux/server' || name === '@wemux/server-domain'), [], `Worker 不得依赖 Server 包：${declared.join(', ')}`)
  assert.ok(declared.includes('@wemux/worker-runtime') === false, 'Worker 不依赖运行时包集合之外的实现细节')
})