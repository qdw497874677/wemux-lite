import { homedir, hostname } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

export type WorkerTransport = 'direct' | 'nc'
export function parseTransport(value: string | undefined): WorkerTransport {
  if (value == null || value === '') return 'direct'
  if (value === 'direct' || value === 'nc') return value
  throw new Error(`不支持的传输通道：${value}（可选 direct 或 nc）`)
}

export function config(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    home: { type: 'string' }, server: { type: 'string' }, servers: { type: 'string' }, token: { type: 'string' }, name: { type: 'string' }, prefer: { type: 'string' }, transport: { type: 'string' },
    host: { type: 'string' }, port: { type: 'string' }, username: { type: 'string' }, 'password-file': { type: 'string' },
    'enrollment-path': { type: 'string' }, 'socket-path': { type: 'string' }, version: { type: 'boolean' },
    path: { type: 'string' }, yes: { type: 'boolean' }, 'secure-cookies': { type: 'boolean' }, force: { type: 'boolean' },
  } })
  const port = Number(values.port ?? env.WEMUX_WORKER_PORT ?? '3002')
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Worker Web port must be an integer between 0 and 65535')
  return { command: values.version ? 'version' : positionals[0] ?? 'help',
    agentAction: positionals[1], agentKey: positionals[2], extraPositionals: positionals.slice(3), agentPath: values.path, yes: values.yes ?? false, force: values.force ?? false,
    adminAction: positionals[1], username: values.username ?? env.WEMUX_LOCAL_ADMIN_USERNAME ?? 'admin', passwordFile: values['password-file'], localAdminPassword: env.WEMUX_LOCAL_ADMIN_PASSWORD,
    host: values.host ?? env.WEMUX_WORKER_HOST ?? '127.0.0.1', port,
    secureCookies: values['secure-cookies'] ?? env.WEMUX_WORKER_SECURE_COOKIES === '1',
    home: resolve(values.home ?? env.WEMUX_WORKER_HOME ?? resolve(homedir(), '.wemux-lite')),
    server: values.server ?? env.WEMUX_SERVER_URL, servers: values.servers ?? env.WEMUX_SERVER_URLS,
    token: values.token ?? env.WEMUX_ENROLLMENT_TOKEN, prefer: values.prefer ?? env.WEMUX_PREFER,
    transport: parseTransport(values.transport ?? env.WEMUX_TRANSPORT),
    name: values.name ?? env.WEMUX_WORKER_NAME ?? hostname(),
    enrollmentPath: values['enrollment-path'] ?? '/workers/enroll', socketPath: values['socket-path'] ?? '/worker/ws' }
}
export function serverUrl(value: string) {
  const url = new URL(value)
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Server URL')
  return url
}
