import { script } from './client.js'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { SocketAddress } from 'node:net'
import type { LocalState } from '../application/ports/local-state.js'
import { verifyLocalAdmin } from '../application/local-installation.js'
import { LocalWorkbenchError, type LocalWorkbenchService } from '../application/local-workbench.js'
import type { ClusterLifecycle } from '../application/cluster-lifecycle.js'
import { parseLocalConnector, redactLocalConnector } from './connector-input.js'
import { installWarning } from '../runtimes/management.js'
import { serveWorkerStatic } from './static-site.js'

const sessionCookie = 'wemux_worker_session'
const sessionLifetimeMs = 8 * 60 * 60 * 1000
const maximumBodyBytes = 16 * 1024
const loginWindowMs = 5 * 60 * 1000
const maximumLoginFailures = 5

type LocalSession = { readonly csrf: string; readonly expiresAt: number }
type LoginFailures = { count: number; firstAt: number }

export interface LocalControlServerOptions {
  readonly host: string
  readonly port: number
  readonly state: LocalState
  readonly secureCookies?: boolean
  readonly webStaticPath?: string
  readonly now?: () => number
}

export interface LocalControlServer {
  readonly url: string
  close(): Promise<void>
}

export interface LocalControlHandlers {
  readonly shutdown?: () => Promise<void>
  readonly workbench?: LocalWorkbenchService
  readonly cluster?: Pick<ClusterLifecycle, 'connection' | 'discover' | 'enroll' | 'connect' | 'pause' | 'resume' | 'leave' | 'agentSettings' | 'selectAgent' | 'resetAgent' | 'listConnectors' | 'saveConnector' | 'deleteConnector' | 'putConnectorCredential' | 'connectorCredentialAvailable' | 'agentInstallation' | 'beginAgentInstallation' | 'listConnectorApprovals' | 'resolveConnectorApproval'>
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const content = JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(content)), 'Cache-Control': 'no-store', ...headers })
  response.end(content)
}

function text(response: ServerResponse, status: number, contentType: string, body: string) {
  response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': String(Buffer.byteLength(body)), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(body)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > maximumBodyBytes) throw new Error('request-too-large')
    chunks.push(value)
  }
  if (!size) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-json')
    return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof Error && error.message === 'request-too-large') throw error
    throw new Error('invalid-json')
  }
}

function optionalIdentity(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new LocalWorkbenchError('请求标识无效')
  return value
}

function cookies(request: IncomingMessage): Map<string, string> {
  const result = new Map<string, string>()
  for (const item of (request.headers.cookie ?? '').split(';')) {
    const separator = item.indexOf('=')
    if (separator < 0) continue
    result.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim())
  }
  return result
}

function isLoopback(host: string) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function hostAllowed(value: string | undefined, configuredHost: string, port: number) {
  if (!value) return false
  const allowed = new Set([`${configuredHost}:${port}`])
  if (isLoopback(configuredHost)) {
    allowed.add(`127.0.0.1:${port}`)
    allowed.add(`localhost:${port}`)
    allowed.add(`[::1]:${port}`)
  }
  return allowed.has(value.toLowerCase())
}

function source(request: IncomingMessage) {
  return request.socket.remoteAddress ?? 'unknown'
}

function page() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wemux Worker</title><link rel="stylesheet" href="/local.css"></head><body><main><header><p class="label">WEMUX WORKER</p><h1>本机智能体工作台</h1><p>直接使用本机目录与 Agent。独立会话不会自动上传到已连接的集群。</p></header><section id="login"><h2>管理员登录</h2><form><label>用户名<input name="username" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button>登录</button><p id="error" role="alert"></p></form></section><section id="status" hidden><div class="row"><div><p class="label">LOCAL CONTROL</p><h2 id="name">Worker</h2></div><button id="logout" class="secondary">退出</button></div><dl><div><dt>安装 ID</dt><dd id="installation"></dd></div><div><dt>集群状态</dt><dd id="cluster"></dd></div><div><dt>Agent 能力</dt><dd id="agents"></dd></div><div><dt>本地状态</dt><dd id="local"></dd></div></dl><p id="cluster-notice" role="alert"></p><div id="cluster-control"><div class="workbench-heading"><div><p class="label">CLUSTER</p><h2>集群接入</h2></div><p>注册口令只用于一次性交换凭据，不会持久化。暂停或退出不会删除本地会话。</p></div><form id="enroll-form" class="session-create"><label>Server 地址<input name="serverUrl" placeholder="http://server:3001" required></label><label>Worker 名称<input name="name" placeholder="可选"></label><label>注册口令<input name="token" type="password" autocomplete="off" required></label><button>探测并加入</button></form><div class="composer-actions cluster-actions"><button id="cluster-connect" type="button" class="secondary">连接</button><button id="cluster-pause" type="button" class="secondary">暂停</button><button id="cluster-leave" type="button" class="danger">退出集群</button></div><p id="cluster-error" role="alert"></p></div><div id="workbench"><div class="workbench-heading"><div><p class="label">LOCAL SESSIONS</p><h2>本地会话</h2></div><p>目录授权只允许在所选路径内启动会话，不代表文件系统沙箱。</p></div><details class="setup" open><summary>新建本地会话</summary><form id="directory-form" class="inline"><label>允许的目录<input name="path" placeholder="/absolute/project/path" required><small>请填写 Worker 所在机器上的绝对路径。</small></label><button>添加目录</button></form><form id="session-form" class="session-create"><label>目录<select name="workspaceId" required></select></label><label>Agent<select name="agentKey" required></select></label><label>模型<select name="modelId" required></select></label><button>新建会话</button></form></details><div class="session-toolbar"><label>当前会话<select id="session-select"><option value="">暂无本地会话</option></select></label><button id="delete-session" class="danger" disabled>删除会话</button></div><div id="session-empty" class="empty">授权目录并选择可用 Agent，新建第一个本地会话。</div><div id="conversation" hidden><button id="load-older" type="button" class="secondary" hidden>加载更早记录</button><div id="timeline" aria-live="polite"></div><h3>待处理消息</h3><div id="queue"></div><div id="approvals"></div><button id="compact" type="button" class="secondary" hidden>压缩上下文</button><form id="message-form"><label>消息<textarea name="content" rows="4" placeholder="输入发送给本机智能体的消息" required></textarea></label><div class="composer-actions"><span id="run-state">待命</span><button id="stop-turn" type="button" class="secondary" disabled>停止运行</button><button id="send-message">发送</button></div></form></div><p id="workbench-error" role="alert"></p></div></section></main><script src="/local.js" defer></script></body></html>`
}

const stylesheet = `:root{color-scheme:dark light;font-family:ui-sans-serif,system-ui,sans-serif;background:#0c0f14;color:#eef2f7;--line:#34404f;--muted:#9ba8b8;--accent:#7fd1ae;--panel:#111720;--field:#0c1118}*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:linear-gradient(120deg,#0c0f14,#151c25)}main{width:min(980px,calc(100% - 32px));margin:0 auto;padding:clamp(48px,10vh,96px) 0}header{border-bottom:1px solid var(--line);padding-bottom:32px;margin-bottom:32px}header>p:last-child{max-width:680px;color:#b8c2cf;line-height:1.65}h1{font-size:clamp(36px,8vw,68px);line-height:.98;letter-spacing:-.05em;max-width:720px;margin:12px 0 20px}h2{font-size:24px;margin:0}.label{font:600 12px ui-monospace,monospace;letter-spacing:.16em;color:var(--accent)}section{background:var(--panel);border:1px solid var(--line);padding:28px}form{display:grid;gap:20px}#login form{max-width:580px;margin-top:24px}form.inline{grid-template-columns:1fr auto;align-items:end;margin:20px 0}.session-create{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) minmax(0,1.2fr) auto;align-items:end;margin-top:20px}label{display:grid;gap:8px;font-size:14px;color:#c5cfdb;min-width:0}small{color:var(--muted);line-height:1.5}input,select,textarea{width:100%;font:inherit;padding:12px 14px;border:1px solid #4a596b;border-radius:6px;background:var(--field);color:#fff;outline:none}input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px #7fd1ae22}button{width:max-content;border:0;border-radius:6px;background:var(--accent);color:#08130f;padding:11px 18px;font:700 14px inherit;cursor:pointer;white-space:nowrap}button:active{transform:translateY(1px)}button:disabled{cursor:not-allowed;opacity:.45;transform:none}button.secondary{background:transparent;color:#dce5ef;border:1px solid #4a596b}button.danger{background:transparent;color:#ffaaa4;border:1px solid #70413f}.row,.session-toolbar,.composer-actions,.workbench-heading{display:flex;align-items:center;justify-content:space-between;gap:20px}.workbench-heading{align-items:start}.workbench-heading>p{max-width:460px;margin:0;color:var(--muted);line-height:1.55}dl{display:grid;grid-template-columns:1fr 1fr;margin:28px 0 0;border-top:1px solid var(--line)}dl div{padding:20px 0;border-bottom:1px solid var(--line)}dt{font-size:12px;color:#8f9cac}dd{margin:7px 0 0;overflow-wrap:anywhere}#cluster-control,#workbench{border-top:1px solid var(--line);margin-top:32px;padding-top:32px}.cluster-actions{justify-content:flex-start;margin-top:16px}#cluster-error,#cluster-notice{min-height:1.5em;color:#ffaaa4}.setup{border:1px solid var(--line);margin-top:24px;padding:16px 18px}.setup summary{cursor:pointer;font-weight:700}.session-toolbar{margin-top:24px}.session-toolbar label{display:grid;grid-template-columns:auto minmax(220px,1fr);align-items:center}.empty{margin-top:24px;padding:32px;border:1px dashed #465568;color:var(--muted);text-align:center}.event{border-left:2px solid #3a4858;padding:10px 12px;margin:10px 0;color:#d5dde7}.event.user{border-color:var(--accent);background:#7fd1ae0d}.event.assistant{border-color:#78a8da}.event.activity{color:var(--muted);font-size:12px}.event.tool{border-color:#d1a866}.event strong{display:block;margin-bottom:5px;color:#fff;font-size:12px}.event pre{margin:6px 0 0;white-space:pre-wrap;font:12px/1.55 ui-monospace,monospace;color:#c8d2dd}.event p{margin:0;white-space:pre-wrap;line-height:1.65}#timeline{margin-top:24px;padding:12px 16px;background:#090d12;border:1px solid #27323f;min-height:180px;max-height:480px;overflow:auto}#message-form{max-width:none;margin-top:16px}.composer-actions{align-items:center;justify-content:flex-end}.composer-actions span{margin-right:auto;color:var(--muted);font-size:13px}#error,#workbench-error{min-height:1.5em;color:#ffaaa4}.notice{color:var(--muted)}@media(max-width:760px){main{padding:32px 0}section{padding:20px}dl{grid-template-columns:1fr}.workbench-heading,.session-toolbar,.composer-actions{align-items:stretch;flex-direction:column}.session-toolbar label{display:grid;grid-template-columns:1fr}.session-create,form.inline{grid-template-columns:1fr}.session-create button,form.inline button,.composer-actions button{width:100%}}@media(prefers-color-scheme:light){:root{background:#f4f6f8;color:#17202b;--line:#cbd3dc;--muted:#5c6877;--panel:#fff;--field:#f8fafc}body{background:linear-gradient(120deg,#eef2f5,#fff)}header>p:last-child,label{color:#475569}input,select,textarea{color:#17202b}.event strong{color:#17202b}.event.assistant{border-color:#376c9f}.event p,.event pre{color:#2e3b49}button.secondary{color:#253445}.empty{border-color:#aab5c1}.event.user{background:#2978580c}#timeline{background:#f8fafc;border-color:#d8dee6}}`



export async function startLocalControlServer(options: LocalControlServerOptions, handlers: LocalControlHandlers = {}): Promise<LocalControlServer> {
  const sessions = new Map<string, LocalSession>()
  const failures = new Map<string, LoginFailures>()
  const streams = new Set<{ response: ServerResponse; close: () => void }>()
  const now = options.now ?? Date.now
  let actualPort = options.port

  const server: Server = createServer(async (request, response) => {
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    if (!hostAllowed(request.headers.host, options.host, actualPort)) return json(response, 400, { error: 'Invalid Host' })
    const origin = request.headers.origin
    if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) return json(response, 403, { error: 'Origin rejected' })

    const token = cookies(request).get(sessionCookie)
    const active = token ? sessions.get(token) : undefined
    if (token && active && active.expiresAt <= now()) sessions.delete(token)
    const authenticated = active && active.expiresAt > now() ? active : undefined

    try {
      if (!options.webStaticPath && request.method === 'GET' && request.url === '/') return text(response, 200, 'text/html; charset=utf-8', page())
      if (!options.webStaticPath && request.method === 'GET' && request.url === '/local.css') return text(response, 200, 'text/css; charset=utf-8', stylesheet)
      if (!options.webStaticPath && request.method === 'GET' && request.url === '/local.js') return text(response, 200, 'text/javascript; charset=utf-8', script)
      if (request.method === 'GET' && request.url === '/api/host') return json(response, 200, { hostKind: 'local-worker', contractVersion: 1, capabilities: ['local-session', 'directories', 'cluster-connection'] })
      if (request.method === 'GET' && request.url === '/api/local/bootstrap') return json(response, 200, { initialized: Boolean(options.state.localAdmin()) })
      if (request.method === 'POST' && request.url === '/api/local/auth/session') {
        const address = source(request)
        const failure = failures.get(address)
        if (failure && now() - failure.firstAt < loginWindowMs && failure.count >= maximumLoginFailures) return json(response, 429, { error: '登录尝试过多，请稍后重试' })
        const body = await readJson(request)
        const admin = options.state.localAdmin()
        const valid = admin && typeof body.username === 'string' && typeof body.password === 'string' && await verifyLocalAdmin(admin, { username: body.username, password: body.password })
        if (!valid) {
          failures.set(address, !failure || now() - failure.firstAt >= loginWindowMs ? { count: 1, firstAt: now() } : { ...failure, count: failure.count + 1 })
          return json(response, 401, { error: '用户名或密码错误' })
        }
        failures.delete(address)
        const sessionToken = randomBytes(32).toString('base64url')
        const session = { csrf: randomBytes(24).toString('base64url'), expiresAt: now() + sessionLifetimeMs }
        sessions.set(sessionToken, session)
        const secure = options.secureCookies ? '; Secure' : ''
        return json(response, 201, { csrf: session.csrf, expiresAt: new Date(session.expiresAt).toISOString() }, { 'Set-Cookie': `${sessionCookie}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionLifetimeMs / 1000)}${secure}` })
      }
      if (request.method === 'DELETE' && request.url === '/api/local/auth/session') {
        if (!authenticated || request.headers['x-wemux-csrf'] !== authenticated.csrf) return json(response, 403, { error: 'Forbidden' })
        if (token) sessions.delete(token)
        return json(response, 204, null, { 'Set-Cookie': `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` })
      }
      if (request.url?.startsWith('/api/local/connectors')) {
        if (!authenticated) return json(response, 401, { error: 'Authentication required' })
        if (!handlers.cluster) return json(response, 409, { error: 'Connector control is unavailable' })
        const target = new URL(request.url, `http://${request.headers.host}`)
        const segments = target.pathname.split('/').filter(Boolean)
        if (request.method === 'GET' && target.pathname === '/api/local/connectors') return json(response, 200, { items: (await handlers.cluster.listConnectors()).map(redactLocalConnector), credentialCapability: handlers.cluster.connectorCredentialAvailable() ? 'available' : 'unavailable' })
        if (request.method === 'GET' && target.pathname === '/api/local/connectors/approvals') return json(response, 200, { items: handlers.cluster.listConnectorApprovals() })
        if (request.method !== 'GET' && request.headers['x-wemux-csrf'] !== authenticated.csrf) return json(response, 403, { error: 'Forbidden' })
        if (request.method === 'POST' && target.pathname === '/api/local/connectors') {
          const definition = parseLocalConnector(await readJson(request))
          const existing = (await handlers.cluster.listConnectors()).find(item => item.id === definition.id)
          if (existing && (existing.projectId !== 'local' || existing.kind !== 'mcp')) return json(response, 409, { error: '连接器标识已由集群占用' })
          if (existing && (definition.revision !== existing.revision + 1 || definition.createdAt !== existing.createdAt)) return json(response, 409, { error: '连接器版本冲突，请刷新后重试' })
          if (!existing && definition.revision !== 1) return json(response, 409, { error: '新建连接器版本必须为 1' })
          if (existing && (JSON.stringify(existing.config) !== JSON.stringify(definition.config) || existing.credentialRef !== definition.credentialRef) && definition.credentialAvailability === 'available') return json(response, 400, { error: '配置或凭据变更后须重新验证凭据' })
          const saved = await handlers.cluster.saveConnector(definition)
          return json(response, 201, redactLocalConnector(saved))
        }
        const connectorId = segments[3] ? decodeURIComponent(segments[3]) : ''
        if (request.method === 'DELETE' && segments.length === 4 && connectorId) {
          if (!/^local-[A-Za-z0-9_-]{1,122}$/.test(connectorId) || !(await handlers.cluster.listConnectors()).some(item => item.id === connectorId && item.projectId === 'local' && item.kind === 'mcp')) return json(response, 404, { error: '本地连接器不存在' })
          await handlers.cluster.deleteConnector(connectorId)
          return json(response, 204, null)
        }
        if (request.method === 'PUT' && segments.length === 5 && segments[4] === 'credential' && connectorId) {
          const body = await readJson(request)
          if (Object.keys(body).some(key => !['id', 'authType', 'secret'].includes(key)) || typeof body.id !== 'string' || !/^local-[A-Za-z0-9_-]{1,122}$/.test(body.id) || (body.authType !== 'api_key' && body.authType !== 'custom_credential') || !body.secret || typeof body.secret !== 'object' || Array.isArray(body.secret) || !Object.keys(body.secret).length || Object.keys(body.secret).length > 64 || Object.entries(body.secret).some(([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || typeof value !== 'string' || Buffer.byteLength(value) > 64 * 1024)) return json(response, 400, { error: '凭证参数无效' })
          if (!/^local-[A-Za-z0-9_-]{1,122}$/.test(connectorId) || !(await handlers.cluster.listConnectors()).some(item => item.id === connectorId && item.projectId === 'local')) return json(response, 404, { error: '本地连接器不存在' })
          const secret = body.secret as Record<string, string>
          if (!(await handlers.cluster.listConnectors()).some(item => item.id === connectorId && item.credentialRef === body.id && item.kind === 'mcp' && (item.config.transport !== 'stdio' || (Object.keys(secret).length === item.config.secretEnvironmentNames.length && item.config.secretEnvironmentNames.every(name => typeof secret[name] === 'string'))))) return json(response, 400, { error: '凭据字段必须匹配本地连接器' })
          const record = await handlers.cluster.putConnectorCredential({ id: body.id as import('@wemux/connector').ConnectorCredentialId, connectorId, authType: body.authType, secret: body.secret as Record<string, string> })
          return json(response, 200, { id: record.id, revision: record.revision, profile: record.profile })
        }
        if (request.method === 'POST' && segments.length === 6 && segments[3] === 'approvals' && segments[5] === 'resolve') {
          const body = await readJson(request)
          if (body.decision !== 'approve' && body.decision !== 'deny') return json(response, 400, { error: '批准决定无效' })
          return json(response, handlers.cluster.resolveConnectorApproval(decodeURIComponent(segments[4]), body.decision) ? 200 : 404, { resolved: true })
        }
        return json(response, 404, { error: 'Not found' })
      }
      if (request.url?.startsWith('/api/local/agents')) {
        if (!authenticated) return json(response, 401, { error: 'Authentication required' })
        if (!handlers.cluster) return json(response, 409, { error: 'Agent settings are unavailable' })
        if (request.method === 'GET' && request.url === '/api/local/agents') return json(response, 200, await handlers.cluster.agentSettings())
        if (request.method === 'GET' && request.url === '/api/local/agents/install') return json(response, 200, { installation: handlers.cluster.agentInstallation() })
        if (request.method === 'POST' && request.url === '/api/local/agents/install') {
          if (request.headers['x-wemux-csrf'] !== authenticated.csrf) return json(response, 403, { error: 'Forbidden' })
          const body = await readJson(request)
          if (typeof body.key !== 'string' || body.confirm !== true || Object.keys(body).some(key => !['key', 'confirm'].includes(key))) return json(response, 400, { error: installWarning })
          return json(response, 202, { installation: handlers.cluster.beginAgentInstallation(body.key) })
        }
        const match = request.url.match(/^\/api\/local\/agents\/([^/?]+)$/)
        if (!match) return json(response, 404, { error: 'Not found' })
        if (request.headers['x-wemux-csrf'] !== authenticated.csrf) return json(response, 403, { error: 'Forbidden' })
        if (request.method === 'PUT') {
          const body = await readJson(request)
          if (typeof body.executable !== 'string') return json(response, 400, { error: 'Agent 路径无效' })
          return json(response, 200, await handlers.cluster.selectAgent(decodeURIComponent(match[1]), body.executable))
        }
        if (request.method === 'DELETE') return json(response, 200, await handlers.cluster.resetAgent(decodeURIComponent(match[1])))
        return json(response, 404, { error: 'Not found' })
      }
      if (request.url?.startsWith('/api/local/cluster/')) {
        if (!authenticated) return json(response, 401, { error: 'Authentication required' })
        if (!handlers.cluster) return json(response, 409, { error: 'Cluster control is unavailable' })
        if (request.headers['x-wemux-csrf'] !== authenticated.csrf) return json(response, 403, { error: 'Forbidden' })
        if (request.method === 'POST' && request.url === '/api/local/cluster/discover') {
          const body = await readJson(request)
          if (typeof body.serverUrl !== 'string') return json(response, 400, { error: 'Server 地址无效' })
          return json(response, 200, await handlers.cluster.discover(body.serverUrl))
        }
        if (request.method === 'POST' && request.url === '/api/local/cluster/enroll') {
          const body = await readJson(request)
          if (typeof body.serverUrl !== 'string' || typeof body.token !== 'string' || !body.token) return json(response, 400, { error: '注册参数无效' })
          const identity = await handlers.cluster.enroll({ serverUrl: body.serverUrl, token: body.token, name: typeof body.name === 'string' ? body.name : undefined })
          await handlers.cluster.connect()
          return json(response, 201, { identity })
        }
        if (request.method === 'POST' && request.url === '/api/local/cluster/connect') { await handlers.cluster.connect(); return json(response, 202, { status: 'connecting' }) }
        if (request.method === 'POST' && request.url === '/api/local/cluster/pause') { await handlers.cluster.pause(); return json(response, 200, { status: 'offline' }) }
        if (request.method === 'POST' && request.url === '/api/local/cluster/resume') { await handlers.cluster.resume(); return json(response, 202, { status: 'connecting' }) }
        if (request.method === 'DELETE' && request.url === '/api/local/cluster/enrollment') { await handlers.cluster.leave(); return json(response, 204, null) }
        return json(response, 404, { error: 'Not found' })
      }
      if (request.url?.startsWith('/api/local/workbench/')) {
        if (!authenticated) return json(response, 401, { error: 'Authentication required' })
        const workbench = handlers.workbench
        if (!workbench) return json(response, 409, { error: 'Workbench is unavailable' })
        const target = new URL(request.url, `http://${request.headers.host}`)
        const segments = target.pathname.split('/').filter(Boolean)
        if (request.method === 'GET' && target.pathname === '/api/local/workbench/directories') return json(response, 200, { items: await workbench.listDirectories() })
        if (request.method === 'POST' && target.pathname === '/api/local/workbench/directories') {
          if (request.headers['x-wemux-csrf'] !== authenticated.csrf) return json(response, 403, { error: 'Forbidden' })
          const body = await readJson(request)
          if (typeof body.path !== 'string') return json(response, 400, { error: '目录路径无效' })
          return json(response, 201, await workbench.addDirectory(body.path))
        }
        if (request.method === 'GET' && target.pathname === '/api/local/workbench/sessions') return json(response, 200, { items: await workbench.listSessions() })
        if (request.method === 'POST' && target.pathname === '/api/local/workbench/sessions') {
          if (request.headers['x-wemux-csrf'] !== authenticated.csrf) return json(response, 403, { error: 'Forbidden' })
          const body = await readJson(request)
          if (typeof body.workspaceId !== 'string' || typeof body.agentKey !== 'string' || (body.modelId !== undefined && body.modelId !== null && typeof body.modelId !== 'string')) return json(response, 400, { error: '会话参数无效' })
          return json(response, 201, await workbench.createSession({ workspaceId: body.workspaceId, agentKey: body.agentKey, modelId: body.modelId ?? null, requestId: optionalIdentity(body.requestId) }))
        }
        const sessionId = segments[4]
        if (request.method === 'DELETE' && segments.length === 5 && segments[3] === 'sessions' && sessionId) {
          if (request.headers['x-wemux-csrf'] !== authenticated.csrf) return json(response, 403, { error: 'Forbidden' })
          return json(response, 200, await workbench.deleteSession(sessionId))
        }
        if (request.method === 'GET' && segments.length === 6 && segments[3] === 'sessions' && segments[5] === 'events' && sessionId) {
          const cursor = request.headers['last-event-id'] ?? target.searchParams.get('fromSeq') ?? '1'
          let fromSeq = Number(Array.isArray(cursor) ? cursor[0] : cursor) + (request.headers['last-event-id'] !== undefined ? 1 : 0)
          if (!Number.isSafeInteger(fromSeq) || fromSeq < 1) return json(response, 400, { error: '事件游标无效' })
          // Validate local session ownership before committing an SSE success response.
          await workbench.journal(sessionId, fromSeq, 1)
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
          response.write('retry: 1000\n\n')
          const streamSession = authenticated
          let closed = false
          let reading = false
          let timer: NodeJS.Timeout | undefined
          const stream = { response, close: () => {} }
          const close = () => {
            if (closed) return
            closed = true
            if (timer) clearInterval(timer)
            streams.delete(stream)
          }
          stream.close = close
          streams.add(stream)
          request.once('close', close)
          const publish = async () => {
            if (closed || reading) return
            if (!token || sessions.get(token) !== streamSession || streamSession.expiresAt <= now()) {
              response.write('event: auth-expired\ndata: {}\n\n')
              response.end()
              close()
              return
            }
            reading = true
            try {
              do {
                const page = await workbench.journal(sessionId, fromSeq, 200)
                for (const event of page.events) {
                  response.write(`id: ${event.seq}\nevent: journal\ndata: ${JSON.stringify(event)}\n\n`)
                  fromSeq = Number(event.seq) + 1
                }
                if (!page.hasMore) break
              } while (!closed)
            } catch {
              if (!closed) response.end()
              close()
            } finally { reading = false }
          }
          await publish()
          if (!closed) timer = setInterval(() => { publish().catch(() => close()) }, 500)
          return
        }
        if (segments[3] === 'sessions' && sessionId && segments.length === 6) {
          if (request.method === 'GET' && segments[5] === 'approvals') return json(response, 200, { items: await workbench.approvals(sessionId) })
          if (request.method === 'GET' && segments[5] === 'queue') return json(response, 200, { items: await workbench.queue(sessionId) })
          if (request.method === 'GET' && segments[5] === 'commands') return json(response, 200, { items: await workbench.supportedCommands(sessionId) })
          if (request.method === 'POST' && segments[5] === 'commands') {
            if (request.headers['x-wemux-csrf'] !== authenticated.csrf) return json(response, 403, { error: 'Forbidden' })
            const body = await readJson(request)
            if (typeof body.name !== 'string') return json(response, 400, { error: '命令无效' })
            return json(response, 202, await workbench.command(sessionId, body.name, optionalIdentity(body.commandId)))
          }
        }
        if (request.method === 'POST' && segments.length === 8 && segments[3] === 'sessions' && segments[5] === 'approvals' && segments[7] === 'resolve' && sessionId) {
          if (request.headers['x-wemux-csrf'] !== authenticated.csrf) return json(response, 403, { error: 'Forbidden' })
          const body = await readJson(request)
          if (body.decision !== 'approve' && body.decision !== 'deny') return json(response, 400, { error: '批准决定无效' })
          return json(response, 202, await workbench.resolveApproval(sessionId, decodeURIComponent(segments[6]), body.decision, optionalIdentity(body.commandId)))
        }
        if (request.method === 'GET' && segments.length === 6 && segments[3] === 'sessions' && segments[5] === 'journal' && sessionId) {
          const fromSeq = Number(target.searchParams.get('fromSeq') ?? '1')
          const limit = Math.min(500, Math.max(1, Number(target.searchParams.get('limit') ?? '200')))
          if (!Number.isSafeInteger(fromSeq) || fromSeq < 0 || !Number.isSafeInteger(limit)) return json(response, 400, { error: '分页参数无效' })
          return json(response, 200, await workbench.journal(sessionId, fromSeq, limit))
        }
        if (request.method === 'POST' && segments.length === 6 && segments[3] === 'sessions' && segments[5] === 'messages' && sessionId) {
          if (request.headers['x-wemux-csrf'] !== authenticated.csrf) return json(response, 403, { error: 'Forbidden' })
          const body = await readJson(request)
          if (typeof body.content !== 'string') return json(response, 400, { error: '消息内容无效' })
          const commandId = optionalIdentity(body.commandId), messageId = optionalIdentity(body.messageId)
          if (Boolean(commandId) !== Boolean(messageId)) return json(response, 400, { error: '消息请求标识不完整' })
          const receipt = await workbench.enqueue(sessionId, body.content, commandId && messageId ? { commandId, messageId } : undefined)
          return json(response, receipt.status === 'accepted' ? 202 : 400, receipt)
        }
        if (request.method === 'DELETE' && segments.length === 8 && segments[3] === 'sessions' && segments[5] === 'queue' && segments[6] && segments[7] === 'cancel' && sessionId) {
          if (request.headers['x-wemux-csrf'] !== authenticated.csrf) return json(response, 403, { error: 'Forbidden' })
          const receipt = await workbench.cancelQueued(sessionId, segments[6])
          return json(response, receipt.status === 'accepted' ? 202 : 400, receipt)
        }
        if (request.method === 'POST' && segments.length === 8 && segments[3] === 'sessions' && segments[5] === 'turns' && segments[6] && segments[7] === 'stop' && sessionId) {
          if (request.headers['x-wemux-csrf'] !== authenticated.csrf) return json(response, 403, { error: 'Forbidden' })
          const receipt = await workbench.stop(sessionId, segments[6])
          return json(response, receipt.status === 'accepted' ? 202 : 400, receipt)
        }
        return json(response, 404, { error: 'Not found' })
      }
      if (request.method === 'POST' && request.url === '/api/local/control/shutdown') {
        if (!authenticated || request.headers['x-wemux-csrf'] !== authenticated.csrf) return json(response, 403, { error: 'Forbidden' })
        if (!handlers.shutdown) return json(response, 409, { error: 'Shutdown is unavailable' })
        json(response, 202, { status: 'stopping' })
        queueMicrotask(() => { handlers.shutdown?.().catch(() => {}) })
        return
      }
      if (request.method === 'GET' && request.url === '/api/local/status') {
        if (!authenticated) return json(response, 401, { error: 'Authentication required' })
        const installation = options.state.localInstallation()
        if (!installation) return json(response, 503, { error: 'Local installation is not initialized' })
        const cluster = options.state.identity()
        const localWorkerId = `local-${installation.installationId}`
        const [workspaces, localSessions] = await Promise.all([options.state.listWorkspaces(), options.state.listSessions()])
        return json(response, 200, {
          csrf: authenticated.csrf,
          installation,
          cluster: cluster ? { enrolled: true, workerId: cluster.workerId, serverUrl: cluster.serverUrl, name: cluster.name ?? null, connection: handlers.cluster?.connection() ?? null } : { enrolled: false, connection: handlers.cluster?.connection() ?? null },
          capabilities: options.state.capabilities(),
          local: {
            workspaces: workspaces.filter(workspace => workspace.projectId === 'local' && workspace.workerId === localWorkerId).length,
            sessions: localSessions.filter(session => session.binding.agent.workerId === localWorkerId).length,
          },
        })
      }
      if (request.method === 'GET' && options.webStaticPath && request.url && !request.url.startsWith('/api/')) {
        const path = new URL(request.url, `http://${request.headers.host}`).pathname
        if (await serveWorkerStatic(response, path, request.headers.accept, options.webStaticPath)) return
      }
      return json(response, 404, { error: 'Not found' })
    } catch (error) {
      if (error instanceof Error && error.message === 'request-too-large') return json(response, 413, { error: 'Request too large' })
      if (error instanceof Error && error.message === 'invalid-json') return json(response, 400, { error: 'Invalid JSON' })
      if (error instanceof LocalWorkbenchError) return json(response, 400, { error: error.message })
      console.error('Local control request failed:', error)
      return json(response, 500, { error: 'Internal error' })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => { server.off('error', reject); resolve() })
  })
  const address = server.address() as SocketAddress
  actualPort = address.port
  const displayHost = options.host.includes(':') ? `[${options.host}]` : options.host
  return {
    url: `http://${displayHost}:${actualPort}`,
    close: async () => {
      for (const stream of [...streams]) {
        stream.close()
        stream.response.end()
      }
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
