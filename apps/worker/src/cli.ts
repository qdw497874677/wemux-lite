#!/usr/bin/env node
import { chmod, mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { config } from './config.js'
import { SqliteWorkerStore } from './storage/sqlite-store.js'
import { defaultAgents } from './agents/detection.js'
import { agentSelections, readAgentSettings } from './config/agent-settings.js'
import { installAgent, installCatalog, installWarning, restartNotice, useAgent } from './runtimes/management.js'
import { activateStagedRuntimes, checkActivatedRuntimes } from './resources/runtime-materializer.ts'
import { ClusterLifecycle } from './application/cluster-lifecycle.js'
import { createLocalAdmin, ensureLocalInstallation } from './application/local-installation.js'
import { createLocalWorkbenchService } from './application/local-workbench.js'
import { startLocalControlServer } from './local-control/server.js'
import { enroll } from './transport/enrollment.js'
import { defaultProbe, preflightServer, probeCli, reportTailscale } from './transport/tailscale.js'
import { openTunnels, type TunnelPool } from './transport/tailscale-tunnel.js'
import { orderEndpoints, parseCandidateUrls, parsePreference, resolveAutoPreference, type ServerEndpoint } from './transport/endpoints.js'

/** nc 模式前置检查：CLI 缺失时给出可操作错误，而不是隧道里一堆 ENOENT。 */
async function requireTailscaleCli(transport: string) {
  if (transport !== 'nc') return null
  const cli = await probeCli(defaultProbe)
  if (!cli.available) throw new Error(`WEMUX_TRANSPORT=nc 需要本机 tailscale CLI（${cli.error}）；请安装 Tailscale 或改用 direct 直连`)
  return cli
}

/** nc 模式下把候选地址换成隧道本地地址；直连模式原样返回。 */
async function tunnelIfNc(transport: string, urls: readonly string[]): Promise<{ urls: readonly string[]; pool: TunnelPool | null }> {
  if (transport !== 'nc') return { urls, pool: null }
  const pool = await openTunnels(urls)
  return { urls: pool.localUrls, pool }
}

async function lock(home: string) {
  const path = join(home, 'runtime.lock')
  try { const file = await open(path, 'wx', 0o600); await file.writeFile(String(process.pid)); await file.close() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const pid = Number(await readFile(path, 'utf8'))
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid runtime.lock; inspect before removing')
    try { process.kill(pid, 0) }
    catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { await rm(path); return lock(home) }
      throw probe
    }
    throw new Error('Worker is already running')
  }
  return async () => { await rm(path, { force: true }) }
}
export async function main(args = process.argv.slice(2)) {
  const options = config(args)
  if (options.command === 'version') { console.log('wemux-lite-worker 0.1.0'); return }
  if (options.command === 'help') { console.log('wemux-lite-worker admin init [--username NAME] [--password-file FILE] | register --server URL [--servers URL1,URL2] [--prefer tailnet|direct|any] [--transport direct|nc] [--force] --token TOKEN | start [--host 127.0.0.1] [--port 3002] [--secure-cookies] [--prefer ...] [--transport ...] | status [--prefer ...] | detect | agent list | agent status | agent use <key> --path /absolute/executable | agent install <pi|opencode|claude> --yes | tailscale [--server URL]；所有命令支持 --home DIR；admin init 也可读取 WEMUX_LOCAL_ADMIN_PASSWORD；register --force 用于替换已存在的本机身份（例如服务器数据被重置后凭据失效）；HTTPS 终止于受信反向代理时启用 --secure-cookies 或 WEMUX_WORKER_SECURE_COOKIES=1；Agent 选择变更需要重启 Worker；--prefer 缺省时自动：检测到 tailscale CLI 且候选含 tailnet 地址则优先 tailnet；--transport nc 让注册与 WebSocket 全部经由 tailscale nc 隧道（不改系统路由，仅支持明文 http 端点）'); return }
  if (!['register', 'start', 'status', 'detect', 'tailscale', 'agent', 'admin'].includes(options.command)) throw new Error('Unknown command')
  await mkdir(options.home, { recursive: true, mode: 0o700 })
  await chmod(options.home, 0o700)
  if (options.command === 'agent') {
    if (options.extraPositionals.length) throw new Error('agent 命令不接受额外位置参数')
    if (options.agentAction === 'use') {
      if (options.yes) throw new Error('agent use 不安装软件，无需 --yes')
      console.log(JSON.stringify(await useAgent(options.home, options.agentKey, options.agentPath), null, 2))
    } else if (options.agentAction === 'install') {
      if (options.agentPath) throw new Error('agent install 不接受 --path 或自定义安装来源')
      console.error(installWarning)
      console.log(JSON.stringify(await installAgent(options.home, options.agentKey, options.yes), null, 2))
    } else if (options.agentAction === 'list' || options.agentAction === 'status') {
      if (options.agentKey || options.agentPath || options.yes) throw new Error('agent list/status 不接受 key、--path 或 --yes')
      const settings = await readAgentSettings(options.home)
      const capabilities = await Promise.all(defaultAgents(settings).map(agent => agent.detect()))
      console.log(JSON.stringify({ selections: agentSelections(settings), capabilities, installCatalog, message: '以上为当前选择及检测结果；变更后需重启 Worker，登录和模型配置需单独完成。' }, null, 2))
    } else throw new Error('使用 agent list | status | use <key> --path 绝对路径 | install <pi|opencode|claude> --yes')
    return
  }
  const release = ['start', 'register', 'admin'].includes(options.command) ? await lock(options.home) : async () => {}
  let store: SqliteWorkerStore | undefined
  try {
    const database = join(options.home, 'worker.sqlite')
    store = new SqliteWorkerStore(database)
    await chmod(database, 0o600)
    if (options.command === 'start') await activateStagedRuntimes(options.home, store.identity()?.workerId)
    let settings = await readAgentSettings(options.home)
    let agents = defaultAgents(settings)
    if (options.command === 'start' && await checkActivatedRuntimes(options.home, store.identity()?.workerId, agents)) {
      console.error('[runtime] Agent 启动探测失败，已回退到原有选择；继续使用回退后的配置')
      settings = await readAgentSettings(options.home)
      agents = defaultAgents(settings)
    }
    const installation = ensureLocalInstallation(store, options.name)
    if (options.command === 'admin') {
      if (options.adminAction !== 'init' || options.extraPositionals.length || options.agentKey) throw new Error('使用 admin init [--username NAME] [--password-file FILE]')
      if (options.agentPath || options.yes) throw new Error('admin init 不接受 --path 或 --yes')
      const password = options.passwordFile ? (await readFile(options.passwordFile, 'utf8')).replace(/[\r\n]+$/, '') : options.localAdminPassword
      if (!password) throw new Error('admin init requires --password-file or WEMUX_LOCAL_ADMIN_PASSWORD')
      const admin = await createLocalAdmin(store, { username: options.username, password })
      console.log(JSON.stringify({ installationId: installation.installationId, username: admin.username, createdAt: admin.createdAt }))
    } else if (options.command === 'register') {
      const existing = store.identity()
      // 换身份会丢弃旧 workerId（旧会话/工作区仍绑定它），因此必须显式 --force：
      // 服务器数据被重置后本机凭据已失效，默认拒绝会让“重新注册”变成空操作。
      if (existing && !options.force) throw new Error(`Worker already has identity ${existing.workerId}；确需换用新身份重新注册请加 --force（旧会话与工作区仍绑定旧 workerId）`)
      if (!(options.server ?? options.servers) || !options.token) throw new Error('register requires --server (or --servers) and --token (or environment equivalents)')
      if (existing) {
        // transport.sqlite 里是上一个身份的 epoch/cursor 与待发队列，留着只会重放旧帧。
        await rm(join(options.home, existing.credentialRef), { force: true })
        await rm(join(options.home, 'transport.sqlite'), { force: true })
      }
      await requireTailscaleCli(options.transport)
      const candidates = parseCandidateUrls(options.servers, options.server)
      // 未显式指定 prefer：候选含 tailnet 且本机有 tailscale CLI 时自动优先 tailnet
      const preferExplicit = options.prefer != null
      const auto = preferExplicit ? { prefer: parsePreference(options.prefer), reason: '' } : await resolveAutoPreference(defaultProbe, candidates)
      const prefer = auto.prefer
      if (!preferExplicit) console.error(`[prefer] 自动选择：${auto.reason}`)
      // 逐个预检：error 的候选不参与首次注册尝试，但保留在身份里供后续故障转移
      const preflightReports: { url: string; verdict: string; message: string }[] = []
      const ordered: ServerEndpoint[] = []
      for (const endpoint of orderEndpoints(candidates, prefer)) {
        const preflight = await preflightServer(defaultProbe, endpoint.url)
        preflightReports.push({ url: endpoint.url, verdict: preflight.verdict, message: preflight.message })
        if (preflight.verdict !== 'skip') console.error(`[tailscale] ${endpoint.url}：${preflight.message}`)
        if (preflight.verdict !== 'error') ordered.push(endpoint)
      }
      const attemptOrder = ordered.length > 0 ? ordered : orderEndpoints(candidates, prefer)
      // nc 模式：注册请求也走 tailscale nc 隧道；身份仍保存原始地址
      const attemptPool = await tunnelIfNc(options.transport, attemptOrder.map(endpoint => endpoint.url))
      let registered: Awaited<ReturnType<typeof enroll>> | null = null
      const failures: string[] = []
      try {
        for (let index = 0; index < attemptOrder.length; index++) {
          const tunnelUrl = attemptPool.urls[index] ?? attemptOrder[index].url
          if (options.transport === 'nc') console.error(`[nc] ${attemptOrder[index].url} → ${tunnelUrl}`)
          try { registered = await enroll({ ...options, server: tunnelUrl, identityServer: attemptOrder[index].url, token: options.token, candidates }); break }
          catch (error) { failures.push(`${attemptOrder[index].url}: ${error instanceof Error ? error.message : error}`) }
        }
      } finally { await attemptPool.pool?.close() }
      if (!registered) throw new Error(`所有候选地址注册失败：\n${failures.join('\n')}`)
      await writeFile(join(options.home, 'credential'), registered.credential, { mode: 0o600 })
      await chmod(join(options.home, 'credential'), 0o600)
      store.saveIdentity(registered.identity)
      console.log(JSON.stringify({ workerId: registered.identity.workerId, serverUrl: registered.identity.serverUrl, serverUrls: registered.identity.serverUrls ?? [registered.identity.serverUrl], transport: options.transport, prefer, preferSource: preferExplicit ? 'explicit' : 'auto', preferReason: auto.reason, preflight: preflightReports }))
    } else if (options.command === 'detect') {
      const capabilities = await Promise.all(agents.map(agent => agent.detect()))
      store.saveCapabilities(capabilities)
      console.log(JSON.stringify(capabilities, null, 2))
    } else if (options.command === 'status') {
      const identity = store.identity()
      const prefer = parsePreference(options.prefer)
      const endpoints = identity ? orderEndpoints(identity.serverUrls ?? [identity.serverUrl], prefer).map(endpoint => ({ ...endpoint, active: endpoint.url === identity.serverUrl })) : []
      console.log(JSON.stringify({ identity, endpoints, prefer, agentSelections: agentSelections(settings), agentSelectionNotice: restartNotice, capabilities: store.capabilities(), workspaces: await store.listWorkspaces(), sessions: await store.listSessions(), tailscale: await reportTailscale(defaultProbe) }, null, 2))
    } else if (options.command === 'tailscale') {
      const server = options.server ?? store.identity()?.serverUrl
      const report = await reportTailscale(defaultProbe)
      const preflight = server ? await preflightServer(defaultProbe, server) : null
      console.log(JSON.stringify({ report, server: server ?? null, preflight }, null, 2))
    } else {
      const identity = store.identity()
      const admin = store.localAdmin()
      if (!identity && !admin) throw new Error('Worker is neither registered nor locally initialized; run admin init first')
      let stopRequested: (() => void) | null = null
      const requestStop = async () => { stopRequested?.() }
      const lifecycle = new ClusterLifecycle(store, agents, {
        home: options.home,
        name: installation.name,
        enrollmentPath: options.enrollmentPath,
        socketPath: options.socketPath,
        transport: options.transport,
        prefer: options.prefer,
        // start 也认 --server/--servers/WEMUX_SERVER_URLS；显式给出时覆盖 identity 里持久化的候选。
        servers: parseCandidateUrls(options.servers, options.server),
        // 连接状态原本只存在内存里，凭据失效这类终态失败在日志里完全隐形；
        // 这里把每次状态转换打出来，让运维能在不看 UI 的情况下定位。
        onStateChange: change => {
          const where = change.endpoint ? ` ${change.endpoint}` : ''
          if (change.current === 'connecting') console.error(`[connect]${where} 正在连接`)
          else if (change.current === 'open') console.error(`[connect]${where} 已连接`)
          else if (change.current === 'backoff') console.error(`[connect]${where} ${change.reason}；${change.retryInMs ?? 0}ms 后重试（第 ${change.attempt} 次）`)
          else if (change.current === 'needs-attention') console.error(`[connect]${where} 需要人工处理：${change.reason}`)
          else if (change.current === 'stopped') console.error(`[connect]${where} 已停止连接`)
        },
        onNotice: message => console.error(`[connect] ${message}`),
      })
      const workbench = createLocalWorkbenchService(store, lifecycle)
      const webStaticPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')
      const hasWebBundle = await stat(join(webStaticPath, 'index.html')).then(file => file.isFile()).catch(() => false)
      if (admin && !hasWebBundle) console.error('[local] 未找到构建的共享 Web，暂时使用内联 Worker 工作台')
      const localControl = admin ? await startLocalControlServer({ host: options.host, port: options.port, state: store, secureCookies: options.secureCookies, webStaticPath: hasWebBundle ? webStaticPath : undefined }, { shutdown: requestStop, workbench, cluster: lifecycle }) : null
      if (localControl) {
        console.error(`[local] Worker Web：${localControl.url}`)
        if (!['127.0.0.1', '::1', 'localhost'].includes(options.host)) console.error('[local] 警告：当前监听非 loopback 地址；首批版本尚未提供完整公网 HTTPS/受信代理配置，请勿直接暴露到公网')
      } else console.error('[local] 尚未初始化本机管理员，保持旧集群模式且不开放 Worker Web；运行 admin init 后重启以启用')
      try {
        if (identity) {
          try { await lifecycle.connect() }
          catch (error) {
            if (!admin) throw error
            console.error(`[connect] 集群连接失败，本地工作台继续可用：${error instanceof Error ? error.message : String(error)}`)
          }
        } else await lifecycle.initializeLocalRuntime()
        await new Promise<void>(resolve => {
          const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); stopRequested = null; resolve() }
          stopRequested = stop
          process.on('SIGINT', stop); process.on('SIGTERM', stop)
        })
      } finally {
        try { await localControl?.close() }
        finally { await lifecycle.close() }
      }
    }
  } finally { store?.close(); await release() }
}
if (await isEntryPoint()) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
}

async function isEntryPoint(): Promise<boolean> {
  if (!process.argv[1]) return false
  try { return import.meta.url === pathToFileURL(await realpath(process.argv[1])).href }
  catch { return import.meta.url === pathToFileURL(process.argv[1]).href }
}
