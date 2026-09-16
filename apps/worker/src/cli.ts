#!/usr/bin/env node
import { chmod, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { config, serverUrl } from './config.js'
import { SqliteWorkerStore } from './storage/sqlite-store.js'
import { defaultAgents } from './agents/detection.js'
import { agentSelections, readAgentSettings } from './config/agent-settings.js'
import { installAgent, installCatalog, installWarning, restartNotice, useAgent } from './runtimes/management.js'
import { LocalProvisioner } from './workspaces/local-provisioner.js'
import { FilesystemAgentLaunchContextProvider } from './application/agent-launch-context-provider.js'
import { CapabilityGateway } from './capabilities/gateway.js'
import { WorkerRuntime } from './application/runtime.js'
import { PiRuntimeSessionAdapter } from './agents/pi-runtime-session-adapter.js'
import { ClaudeRuntimeSessionAdapter } from './agents/claude-runtime-session-adapter.js'
import { WebSocketTransport } from './transport/websocket.js'
import { enroll, toSocketUrl } from './transport/enrollment.js'
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
  if (options.command === 'help') { console.log('wemux-lite-worker register --server URL [--servers URL1,URL2] [--prefer tailnet|direct|any] [--transport direct|nc] --token TOKEN | start [--prefer ...] [--transport ...] | status [--prefer ...] | detect | agent list | agent status | agent use <key> --path /absolute/executable | agent install <pi|claude> --yes | tailscale [--server URL]；所有命令支持 --home DIR；Agent 选择变更需要重启 Worker；--prefer 缺省时自动：检测到 tailscale CLI 且候选含 tailnet 地址则优先 tailnet；--transport nc 让注册与 WebSocket 全部经由 tailscale nc 隧道（不改系统路由，仅支持明文 http 端点）'); return }
  if (!['register', 'start', 'status', 'detect', 'tailscale', 'agent'].includes(options.command)) throw new Error('Unknown command')
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
    } else throw new Error('使用 agent list | status | use <key> --path 绝对路径 | install <pi|claude> --yes')
    return
  }
  const release = ['start', 'register'].includes(options.command) ? await lock(options.home) : async () => {}
  let store: SqliteWorkerStore | undefined
  try {
    const database = join(options.home, 'worker.sqlite')
    store = new SqliteWorkerStore(database)
    await chmod(database, 0o600)
    const settings = await readAgentSettings(options.home)
    const agents = defaultAgents(settings)
    if (options.command === 'register') {
      if (store.identity()) throw new Error('Worker is already registered; use its existing identity')
      if (!(options.server ?? options.servers) || !options.token) throw new Error('register requires --server (or --servers) and --token (or environment equivalents)')
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
      if (!identity) throw new Error('Worker is not registered')
      await requireTailscaleCli(options.transport)
      const candidates = (identity.serverUrls ?? [identity.serverUrl]).map(url => toSocketUrl(url, options.socketPath).href)
      const preferExplicit = options.prefer != null
      const auto = preferExplicit ? { prefer: parsePreference(options.prefer), reason: '' } : await resolveAutoPreference(defaultProbe, candidates)
      const prefer = auto.prefer
      if (!preferExplicit) console.error(`[prefer] 自动选择：${auto.reason}`)
      const ordered = orderEndpoints(candidates, prefer)
      // 预检仅降级不阻断：error 的候选排到末尾，连接持续重试
      const usable: ServerEndpoint[] = []
      const deferred: ServerEndpoint[] = []
      for (const endpoint of ordered) {
        const preflight = await preflightServer(defaultProbe, endpoint.url)
        if (preflight.verdict === 'error') { console.error(`[tailscale] ${endpoint.url}：${preflight.message}；已降级为末位候选`); deferred.push(endpoint) }
        else { if (preflight.verdict !== 'skip') console.error(`[tailscale] ${endpoint.url}：${preflight.message}`); usable.push(endpoint) }
      }
      const originalOrder = usable.concat(deferred).map(endpoint => endpoint.url)
      console.error(`[connect] 候选地址（prefer=${prefer}${options.transport === 'nc' ? '，transport=nc' : ''}）：${originalOrder.join(' → ')}`)
      // nc 模式：每个候选一条 tailscale nc 隧道，WebSocket/心跳/能力网关全部走本地隧道地址；
      // 轮换、重连、回切优先地址等语义与直连完全一致。
      const tunneled = await tunnelIfNc(options.transport, originalOrder)
      const finalOrder = tunneled.urls as string[]
      if (tunneled.pool) for (let index = 0; index < originalOrder.length; index++) console.error(`[nc] ${originalOrder[index]} → ${finalOrder[index]}`)
      serverUrl(finalOrder[0])
      const credential = await readFile(join(options.home, 'credential'), 'utf8')
      let runtime: WorkerRuntime
      const gateway = new CapabilityGateway(finalOrder[0])
      const capabilityEndpoint = await gateway.listen()
      const transport = new WebSocketTransport({ url: finalOrder[0], urls: finalOrder, credential }, message => runtime.receive(message), () => runtime.connected(), console.error, (url, reason) => console.error(`[connect] 切换到候选地址 ${originalOrder[finalOrder.indexOf(url)] ?? url}（${reason === 'connect-failed' ? '连接失败' : '连续重连失败'}）`))
      const runtimeAdapters = new Map()
      const selected = await readAgentSettings(options.home)
      for (const agent of agents) {
        if (agent.agentKey === 'pi') runtimeAdapters.set(agent.agentKey, new PiRuntimeSessionAdapter(selected.pi?.executable ?? 'pi'))
        if (agent.agentKey === 'claude') runtimeAdapters.set(agent.agentKey, new ClaudeRuntimeSessionAdapter(selected['claude-code']?.executable ?? 'claude'))
      }
      runtime = new WorkerRuntime(store, new LocalProvisioner(join(options.home, 'workspaces')), agents, transport, identity.workerId, identity.name ?? options.name, new FilesystemAgentLaunchContextProvider(options.home, capabilityEndpoint), undefined, runtimeAdapters)
      await runtime.initialize()
      transport.start()
      await new Promise<void>(resolve => {
        const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve() }
        process.on('SIGINT', stop); process.on('SIGTERM', stop)
      })
      transport.stop()
      await runtime.shutdown()
      await gateway.close()
      await tunneled.pool?.close()
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
