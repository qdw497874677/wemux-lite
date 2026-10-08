import { TaskService } from './application/task-service.ts'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { SqliteServerStore } from './storage/sqlite/store.ts'
import { SharedSqliteDatabase } from './storage/sqlite/shared-database.ts'
import { AuthenticationService } from './application/auth.ts'
import { AdministratorDirectory, parseAdministratorEmails } from './application/administrator-directory.ts'
import { IdentityService, defaultLoginSessionPolicy, defaultSessionCookieName, systemClock } from './application/identity-service.ts'
import { InstanceSettingsService } from './application/instance-settings.ts'
import { EmailRegistrationService } from './application/email-registration.ts'
import { AccountSecurityService } from './application/account-security-service.ts'
import { GoogleAuthenticationService, resolveGoogleSettings, type GoogleEnvironment } from './application/google-authentication.ts'
import type { GoogleTokenVerifier } from './application/google-oidc.ts'
import { resolveMailSettings, type MailEnv, type MailSettings } from './application/mail/email-delivery.ts'
import { CapabilityService } from './application/capability-service.ts'
import { CapabilityTokenService } from './application/capability-token-service.ts'
import { now } from './application/server-service.ts'
import { Notifications } from './application/notifications.ts'
import { ServerService } from './application/server-service.ts'
import { SessionLineageService } from './application/session-lineage-service.ts'
import { TeamService } from './application/team-service.ts'
import { ProjectAccessService } from './application/project-access-service.ts'
import { ProjectionService } from './application/projection-service.ts'
import { ApprovalDecisionRouter } from './application/approval-decision-router.ts'
import { AttentionService } from './application/attention-service.ts'
import { ArtifactService } from './application/artifact-service.ts'
import { ResourceService } from './application/resource-service.ts'
import { CanvasCollaborationService } from './application/canvas-collaboration-service.ts'
import { CanvasLayoutService } from './application/canvas-layout-service.ts'
import { ConnectorService } from './application/connector-service.ts'
import { ChannelService } from './application/channel-service.ts'
import { ChannelRouter } from './application/channel-router.ts'
import { ChannelOutbox } from './application/channel-outbox.ts'
import { GenericWebhookAdapter } from './channels/generic-webhook-adapter.ts'
import { FeishuAdapter } from './channels/feishu/adapter.ts'
import { FeishuTokenProvider } from './channels/feishu/token-provider.ts'
import { DingTalkAdapter, type DingTalkAdapterOptions } from './channels/dingtalk/adapter.ts'
import type { ChannelAdapter } from './channels/channel-adapter.ts'
import { AesGcmSecretCodec } from '@wemux/connector'
import { SqliteCanvasLayoutRepository } from './storage/sqlite/canvas-layout-repository.ts'
import { SqliteConnectorRepository } from './storage/sqlite/connector-repository.ts'
import { SqliteChannelRepository } from './storage/sqlite/channel-repository.ts'
import { SqliteApprovalDecisionRepository } from './storage/sqlite/approval-decision-repository.ts'
import { SqliteAttentionSource } from './storage/sqlite/attention-source.ts'
import { SqliteArtifactRepository } from './storage/sqlite/artifact-repository.ts'
import { SqliteResourceRepository } from './storage/sqlite-resource-repository.ts'
import { ResourceBlobStore } from './storage/resource-blob-store.ts'
import { SqliteDelegationRepository } from './storage/sqlite/delegation-repository.ts'
import { DelegationApplicationService } from './application/delegation-service.ts'
import { WorkerAccessService } from './application/worker-access-service.ts'
import { SessionAccessService } from './application/session-access-service.ts'
import { PersonalAccessTokenService } from './application/personal-access-token-service.ts'
import { AccountLifecycleService } from './application/account-lifecycle-service.ts'
import { WorkerService } from './application/worker-service.ts'
import { SessionFileService } from './application/session-file-service.ts'
import { SessionTerminalService } from './application/session-terminal-service.ts'
import { httpHandler } from './http/handler.ts'
import { SessionStreams } from './http/sse.ts'
import { TerminalStreams } from './http/terminal-sse.ts'
import { ProjectStreams } from './http/project-sse.ts'
import { CanvasCollaborationStreams } from './http/canvas-collaboration-sse.ts'
import type { StaticSite } from './http/static.ts'
import { WorkerGateway } from './worker-ws/gateway.ts'
import { ServerTransportStore } from './worker-ws/transport-store.ts'

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
  /** Independently built UI mounted at /next/; the root UI remains unchanged. */
  webNextStaticPath?: string
  adminSessionTtlMs?: number
  /** 邮件投递配置；不传则读环境变量。未配置或配错时注册入口保持关闭并在 /auth/options 报告原因。 */
  mail?: MailEnv
  /** Google 登录配置；不传则读环境变量。未配置时按钮不展示、入口拒绝；半配置或明文回调在启动时就失败。 */
  google?: GoogleEnvironment
  /** 自托管替身 Provider（本地验收、集成测试）用的令牌验证器；生产不要传。 */
  googleVerifier?: GoogleTokenVerifier
  /** Channel token encryption key; defaults to WEMUX_CONNECTOR_ENCRYPTION_KEY. */
  channelEncryptionKey?: string
  /** Test/deployment guarded-fetch override for Channel callbacks and Feishu OpenAPI. */
  channelFetch?: typeof fetch
  /** Override Feishu OpenAPI root for local protocol fixtures. */
  feishuApiBaseUrl?: string
  /** DingTalk Stream transport overrides for local protocol fixtures. */
  dingTalk?: DingTalkAdapterOptions
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
  // 主库仓储共用单连接与 FIFO；presenceReset 仍只由真正拥有 Worker 连接的 Server 启动入口触发。
  const database = new SharedSqliteDatabase(options.databasePath)
  const store = new SqliteServerStore(database, { presenceReset: true })
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
  const canvasCollaboration = new CanvasCollaborationService(projects, sessionAccess, notifications)
  const canvasCollaborationStreams = new CanvasCollaborationStreams(canvasCollaboration, notifications)
  const personalAccessTokens = new PersonalAccessTokenService(store)
  const lifecycle = new AccountLifecycleService(store, administrators, identity, notifications)
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
  const connectorRepository = new SqliteConnectorRepository(database)
  const capabilities = new CapabilityService(store, now, new CapabilityTokenService(capabilitySecret, now), connectorRepository)
  const service = new ServerService(store, notifications, capabilities, workerAccess, projects, sessionAccess)
  const delegationRepository = new SqliteDelegationRepository(database)
  const delegations = new DelegationApplicationService(
    delegationRepository,
    {
      resolve: async sessionId => {
        const session = await store.resources.getSession(sessionId)
        if (!session || session.deletedAt !== null) throw new Error('Delegation Session not found')
        return { workerId: session.binding.agent.workerId, capabilities: ['agent.send', 'agent.inbox.list', 'agent.inbox.read'], allowedProjectIds: [session.projectId] }
      },
    },
    {
      deliverRequest: delegation => capabilities.sendDelegationRequest(delegation),
      deliverResult: (delegation, silent) => capabilities.sendDelegationResult(delegation, silent),
    },
    { appendResult: async () => {} },
    { requestCrossProjectApproval: async () => {} },
    now,
  )
  capabilities.attachDelegations(delegations)
  const approvalDecisionRepository = new SqliteApprovalDecisionRepository(database)
  const projections = new ProjectionService(store, projects, sessionAccess, approvalDecisionRepository)
  const attentionSource = new SqliteAttentionSource(database)
  const attention = new AttentionService(projections, attentionSource, store)
  const streams = new SessionStreams(service)
  const terminalStreams = new TerminalStreams(notifications)
  // 血缘服务与画布渲染无关：它只读写领域事实，查询端点不在 handler 里拼装边。
  const lineage = new SessionLineageService(store, service, administrators, undefined, notifications)
  const canvasLayouts = new CanvasLayoutService(store, new SqliteCanvasLayoutRepository(store), projects, lineage)
  const projectStreams = new ProjectStreams(notifications)
  let gateway: WorkerGateway | undefined
  const connectors = new ConnectorService(connectorRepository, store, projects, workerAccess, notifications)
  const channelRepository = new SqliteChannelRepository(database)
  const encryptionKey = options.channelEncryptionKey?.trim() || process.env.WEMUX_CONNECTOR_ENCRYPTION_KEY?.trim()
  const channelCodec = encryptionKey ? new AesGcmSecretCodec({ currentKey: encryptionKey, previousKeys: process.env.WEMUX_CONNECTOR_ENCRYPTION_PREVIOUS_KEYS?.split(',').map(value => value.trim()).filter(Boolean) }) : null
  const channelRouter = new ChannelRouter(channelRepository, sessionAccess, projects, workerAccess, service)
  const genericWebhook = new GenericWebhookAdapter(channelRepository, channelCodec, options.channelFetch)
  const feishuApiBaseUrl = options.feishuApiBaseUrl ?? 'https://open.feishu.cn/open-apis'
  const feishu = new FeishuAdapter(channelRepository, channelCodec, new FeishuTokenProvider(options.channelFetch ?? fetch, Date.now, undefined, feishuApiBaseUrl), feishuApiBaseUrl)
  const dingTalk = new DingTalkAdapter(channelRepository, channelCodec, { ...options.dingTalk, fetch: options.dingTalk?.fetch ?? options.channelFetch })
  const adapters = new Map<string, ChannelAdapter>([['generic_webhook', genericWebhook], ['feishu', feishu], ['dingtalk', dingTalk]])
  const channels = new ChannelService(channelRepository, channelCodec, projects, sessionAccess, workerAccess, kind => adapters.get(kind))
  const channelOutbox = new ChannelOutbox(channelRepository, projects, sessionAccess, workerAccess, store, { deploymentAllowsPrivateNetwork: process.env.WEMUX_CONNECTOR_ALLOW_PRIVATE_NETWORK === 'true', connectorAllowsPrivateNetwork: true }, options.channelFetch, kind => adapters.get(kind)!)
  const resourceRepository = new SqliteResourceRepository(database)
  const resourceBlobs = new ResourceBlobStore(options.databasePath === ':memory:' ? join(process.cwd(), 'data', 'resource-blobs') : join(dirname(options.databasePath), 'resource-blobs'))
  let resources: ResourceService
  const workers = new WorkerService(store, notifications, (workerId, report) => connectors.report(workerId, report), async (sessionId, events) => { await channelOutbox.projectJournal(sessionId, events); setImmediate(() => void channelOutbox.drain().catch(() => undefined)) }, null, resourceBlobs)
  const workerGateway = { send: (workerId: import('@wemux/domain').WorkerId, payload: import('@wemux/wire-protocol').ServerPayload) => {
    if (!gateway) throw new Error('Worker gateway is not ready')
    return gateway.send(workerId, payload)
  } }
  resources = new ResourceService(resourceRepository, { send: (workerId, payload) => { void workerGateway.send(workerId, payload) } }, undefined, resourceBlobs)
  workers.attachResources(resources)
  const sessionFiles = new SessionFileService(service, workers, workerGateway)
  const sessionTerminals = new SessionTerminalService(service, workers, workerGateway)
  const tasks = new TaskService(store, event => notifications.project(event), service)
  capabilities.attachProjectQueries(projects, workerAccess, sessionAccess, tasks, service)
  const artifactRepository = new SqliteArtifactRepository(database)
  const artifacts = new ArtifactService(artifactRepository, store, projects)
  const approvalDecisions = new ApprovalDecisionRouter(projections, tasks, service, approvalDecisionRepository)
  const server = createServer(httpHandler({
    service,
    auth,
    streams,
    capabilities,
    downloads: options.workerPackagePath ? { tarballPath: options.workerPackagePath } : undefined,
    control: { disconnectWorker: id => gateway?.disconnect(id) },
    staticSite: options.webStaticPath ? { root: options.webStaticPath } : undefined,
    nextStaticSite: options.webNextStaticPath ? { root: options.webNextStaticPath } : undefined,
    tasks,
    projectStreams,
    identity,
    registration,
    settings,
    google,
    lineage,
    security,
    teams,
    mail: mail.settings,
    projects,
    workerAccess,
    sessionAccess,
    sessionFiles,
    sessionTerminals,
    terminalStreams,
    personalAccessTokens,
    lifecycle,
    canvasCollaboration,
    canvasCollaborationStreams,
    canvasLayouts,
    connectors,
    channels,
    channelRouter,
    channelOutbox,
    genericWebhook,
    feishu,
    dingTalk,
    projections,
    approvalDecisions,
    attention,
    artifacts,
    resources,
  }))
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
      for (const channel of await channelRepository.listEnabledChannels()) {
        if (channel.kind === 'dingtalk' && channel.enabled) await dingTalk.start(channel.id)
      }
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
      terminalStreams.close()
      projectStreams.close()
      canvasCollaborationStreams.close()
      await gateway.close()
      await dingTalk.stopAll()
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      connectorRepository.close()
      channelRepository.close()
      approvalDecisionRepository.close()
      artifactRepository.close()
      resourceRepository.close()
      attentionSource.close()
      delegationRepository.close()
      store.close()
      database.close()
    },
  }
}
