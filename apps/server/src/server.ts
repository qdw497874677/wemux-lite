import { TaskService } from './application/task-service.js'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { SqliteServerStore } from './storage/sqlite/store.js'
import { AuthenticationService } from './application/auth.js'
import { AdministratorDirectory, parseAdministratorEmails } from './application/administrator-directory.js'
import { IdentityService, defaultLoginSessionPolicy, defaultSessionCookieName, systemClock } from './application/identity-service.js'
import { InstanceSettingsService } from './application/instance-settings.js'
import { EmailRegistrationService } from './application/email-registration.js'
import { AccountSecurityService } from './application/account-security-service.js'
import { GoogleAuthenticationService, resolveGoogleSettings, type GoogleEnvironment } from './application/google-authentication.js'
import type { GoogleTokenVerifier } from './application/google-oidc.js'
import { resolveMailSettings, type MailEnv, type MailSettings } from './application/mail/email-delivery.js'
import { CapabilityService } from './application/capability-service.js'
import { CapabilityTokenService } from './application/capability-token-service.js'
import { now } from './application/server-service.js'
import { Notifications } from './application/notifications.js'
import { ServerService } from './application/server-service.js'
import { SessionLineageService } from './application/session-lineage-service.js'
import { TeamService } from './application/team-service.js'
import { ProjectAccessService } from './application/project-access-service.js'
import { WorkerAccessService } from './application/worker-access-service.js'
import { SessionAccessService } from './application/session-access-service.js'
import { PersonalAccessTokenService } from './application/personal-access-token-service.js'
import { WorkerService } from './application/worker-service.js'
import { httpHandler } from './http/handler.js'
import { SessionStreams } from './http/sse.js'
import { ProjectStreams } from './http/project-sse.js'
import type { StaticSite } from './http/static.js'
import { WorkerGateway } from './worker-ws/gateway.js'
import { ServerTransportStore } from './worker-ws/transport-store.js'

export interface WemuxServerOptions {
  databasePath: string
  /**
   * 实例管理员邮箱（部署者本人）。不传则读 `WEMUX_ADMIN_EMAILS`。
   * 这是唯一的授权根：没有引导令牌也没有首次认领表单。
   */
  administratorEmails?: string | readonly string[]
  /** 能力令牌签名密钥；不传则读 `WEMUX_CAPABILITY_SECRET`，两者都没有时进程内随机生成并警告。 */
  capabilitySecret?: string
  workerPackagePath?: string
  webStaticPath?: string
  adminSessionTtlMs?: number
  /** 邮件投递配置；不传则读环境变量。未配置或配错时注册入口保持关闭并在 /auth/options 报告原因。 */
  mail?: MailEnv
  /** Google 登录配置；不传则读环境变量。未配置时按钮不展示、入口拒绝；半配置或明文回调在启动时就失败。 */
  google?: GoogleEnvironment
  /** 自托管替身 Provider（本地验收、集成测试）用的令牌验证器；生产不要传。 */
  googleVerifier?: GoogleTokenVerifier
}

/** 邮件配置错误不阻断控制面启动：降级为“不可用 + 原因”，由 /auth/options 公开。 */
function resolveMailSafely(env: MailEnv): { settings: MailSettings | null; reason: string | null } {
  try {
    return resolveMailSettings(env)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`[wemux] 邮件投递配置无效，注册邮件将不可用: ${reason}`)
    return { settings: null, reason }
  }
}

/**
 * 能力令牌密钥的兜底：没有显式配置时按进程随机生成。
 * 这是“不静默降低安全性”，但会让上一次进程签发的能力令牌在重启后失效，因此要说出声。
 */
function randomCapabilitySecret(): string {
  console.warn('[wemux] 未配置 WEMUX_CAPABILITY_SECRET：本次进程随机生成能力密钥，重启后既有能力令牌失效')
  return randomBytes(32).toString('base64url')
}

export function createWemuxServer(options: WemuxServerOptions) {
  // 只有真正提供连接的 Server 进程才能重置在线状态：启动瞬间确实没有任何 Worker 连接。
  const store = new SqliteServerStore(options.databasePath, { presenceReset: true })
  const administrators = new AdministratorDirectory(store.identity, parseAdministratorEmails(options.administratorEmails ?? process.env.WEMUX_ADMIN_EMAILS))
  const auth = new AuthenticationService(store, administrators)
  // 浏览器会话策略只有一份：账号安全里的强认证窗口与撤销语义必须和登录态完全一致。
  const sessionPolicy = options.adminSessionTtlMs ? { ...defaultLoginSessionPolicy, idleMs: options.adminSessionTtlMs } : defaultLoginSessionPolicy
  const identity = new IdentityService(store, administrators, systemClock, sessionPolicy, process.env.WEMUX_SESSION_COOKIE_NAME ?? defaultSessionCookieName)
  const settings = new InstanceSettingsService(store, systemClock)
  const mail = resolveMailSafely(options.mail ?? {
    WEMUX_SMTP_URL: process.env.WEMUX_SMTP_URL,
    WEMUX_SMTP_FROM: process.env.WEMUX_SMTP_FROM,
    WEMUX_PUBLIC_URL: process.env.WEMUX_PUBLIC_URL,
    WEMUX_MAIL_OUTBOX: process.env.WEMUX_MAIL_OUTBOX,
  })
  const notifications = new Notifications()
  const teams = new TeamService(store, notifications)
  const projects = new ProjectAccessService(store, notifications)
  const workerAccess = new WorkerAccessService(store, notifications)
  const sessionAccess = new SessionAccessService(store, projects, notifications)
  const personalAccessTokens = new PersonalAccessTokenService(store)
  const registration = new EmailRegistrationService({ store, identity, settings, mail: mail.settings, mailReason: mail.reason, teams })
  // Google 的半配置会抛错：设计上宁可部署启动失败，也不要等用户点击后才发现回调地址不存在。
  const googleSettings = resolveGoogleSettings(options.google ?? {
    WEMUX_GOOGLE_CLIENT_ID: process.env.WEMUX_GOOGLE_CLIENT_ID,
    WEMUX_GOOGLE_CLIENT_SECRET: process.env.WEMUX_GOOGLE_CLIENT_SECRET,
    WEMUX_PUBLIC_URL: process.env.WEMUX_PUBLIC_URL,
  })
  const google = new GoogleAuthenticationService({ store, identity, settings, google: googleSettings.settings, reason: googleSettings.reason, verifier: options.googleVerifier })
  // 账号安全（Ticket 06/08）与会话策略共用同一套参数：强认证窗口与撤销规则不允许有两份实现。
  const security = new AccountSecurityService({ store, identity, mail: mail.settings, mailReason: mail.reason, sessionPolicy })
  const capabilitySecret = options.capabilitySecret ?? process.env.WEMUX_CAPABILITY_SECRET ?? randomCapabilitySecret()
  const capabilities = new CapabilityService(store, now, new CapabilityTokenService(capabilitySecret, now))
  const service = new ServerService(store, notifications, capabilities, workerAccess, projects, sessionAccess)
  const streams = new SessionStreams(service)
  // 血缘服务与画布渲染无关：它只读写领域事实，查询端点不在 handler 里拼装边。
  const lineage = new SessionLineageService(store, service, administrators, undefined, notifications)
  const projectStreams = new ProjectStreams(notifications)
  let gateway: WorkerGateway | undefined
  const server = createServer(httpHandler(service, auth, streams, capabilities, options.workerPackagePath ? { tarballPath: options.workerPackagePath } : undefined, { disconnectWorker: id => gateway?.disconnect(id) }, options.webStaticPath ? { root: options.webStaticPath } : undefined, options.adminSessionTtlMs, new TaskService(store, event => notifications.project(event), service), projectStreams, identity, registration, settings, google, lineage, security, teams, mail.settings, projects, workerAccess, sessionAccess, personalAccessTokens))
  const workers = new WorkerService(store, notifications)
  gateway = new WorkerGateway(server, auth, workers, notifications, new ServerTransportStore(options.databasePath === ':memory:' ? ':memory:' : `${options.databasePath}.transport`))
  let closed = false
  return {
    server,
    /** 存储实例：测试夹具与诊断命令需要直接读归属事实（如实例管理员名册）。 */
    store,
    /** 服务层实例：部署者的默认环境等幂等初始化要能被测试与命令行直接复用。 */
    service,
    async listen(port = 3001, host = '127.0.0.1') {
      await workers.recoverRuns()
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => { server.off('error', reject); resolve() })
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No TCP address')
      return `http://${host}:${address.port}`
    },
    async close() {
      if (closed) return
      closed = true
      streams.close()
      projectStreams.close()
      await gateway.close()
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      store.close()
    },
  }
}
