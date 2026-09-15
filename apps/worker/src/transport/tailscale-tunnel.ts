import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server, type Socket } from 'node:net'
import { tailscaleArgs } from './tailscale-command.js'

/** nc 子进程工厂 seam：生产走 tailscale CLI，测试注入假实现。 */
export type NcSpawner = (host: string, port: number) => ChildProcess

// macOS Homebrew 或自定义部署常把 daemon socket 放在非默认路径（如 /tmp/tailscaled.socket）；
// WEMUX_TS_SOCKET 可显式指定，避免 "dial unix /var/run/tailscaled.socket: no such file"。
export function ncSpawnArgs(host: string, port: number | string): string[] {
  return tailscaleArgs(['nc', host, String(port)])
}

export const defaultNcSpawner: NcSpawner = (host, port) => spawn('tailscale', ncSpawnArgs(host, port), { stdio: ['pipe', 'pipe', 'inherit'] })

/**
 * 把一个远端 (host, port) 映射到本地 127.0.0.1 监听端口的 TCP 隧道。
 * 每个进入的本地连接各 spawn 一个 `tailscale nc host port` 子进程并双向转发字节流：
 * - WebSocket 长连接 = 一个长期存活的子进程；
 * - 短暂 HTTP 请求 = 请求结束（任一端关闭）即回收子进程。
 * 只影响本 worker 的连接：不改系统路由、不设代理、不影响同机其他程序。
 */
export class TailscaleTunnel {
  private server?: Server
  private readonly children = new Set<ChildProcess>()
  private localUrlValue: string | null = null

  constructor(private readonly host: string, private readonly port: number, private readonly spawnNc: NcSpawner = defaultNcSpawner) {}

  get localUrl(): string {
    if (!this.localUrlValue) throw new Error('Tailscale tunnel is not listening')
    return this.localUrlValue
  }

  async listen(): Promise<string> {
    if (this.localUrlValue) return this.localUrlValue
    const server = createServer(socket => this.forward(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Tailscale tunnel has no TCP address')
    this.server = server
    this.localUrlValue = `http://127.0.0.1:${address.port}`
    return this.localUrlValue
  }

  async close(): Promise<void> {
    if (!this.server) return
    for (const child of this.children) { if (child.exitCode === null && !child.killed) child.kill('SIGTERM') }
    this.children.clear()
    await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()))
    this.server = undefined
    this.localUrlValue = null
  }

  private forward(socket: Socket) {
    const child = this.spawnNc(this.host, this.port)
    this.children.add(child)
    let closed = false
    const cleanup = () => {
      if (closed) return
      closed = true
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
      this.children.delete(child)
      socket.destroy()
    }
    child.on('exit', cleanup)
    child.on('error', cleanup)
    socket.on('close', cleanup)
    socket.on('error', cleanup)
    if (!child.stdin || !child.stdout) { cleanup(); return }
    child.stdout.pipe(socket)
    socket.pipe(child.stdin)
    child.stdout.on('error', cleanup)
    child.stdin.on('error', cleanup)
  }
}

export interface TunnelPool {
  /** 与输入一一对应的本地 URL 列表（保留协议映射与路径，主机端口替换为隧道）。 */
  readonly localUrls: readonly string[]
  close(): Promise<void>
}

/**
 * 为每个候选地址开一条独立隧道；多候选的轮换/重连语义保持不变，
 * 持久化身份继续保存原始地址（重启后隧道端口会变，原始地址才是稳定事实）。
 * 隧道是透明 TCP 流，本地 URL 保留原协议（http/ws）；https/wss 需要 TLS 端到端
 * 校验，无法在 127.0.0.1 回环上完成 —— nc 模式仅支持明文端点（内网/tailnet HTTP 部署）。
 */
export async function openTunnels(urls: readonly string[], spawnNc: NcSpawner = defaultNcSpawner): Promise<TunnelPool> {
  const tunnels = new Map<string, TailscaleTunnel>()
  const localUrls: string[] = []
  for (const url of urls) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'ws:') throw new Error(`tailscale nc 隧道仅支持明文 http/ws 端点，收到 ${parsed.protocol}//${parsed.host}；请为该地址改用直连或配置 TLS 域名`)
    const key = `${parsed.hostname}:${parsed.port || '80'}`
    let tunnel = tunnels.get(key)
    if (!tunnel) { tunnel = new TailscaleTunnel(parsed.hostname, Number(key.split(':')[1]), spawnNc); tunnels.set(key, tunnel) }
    const local = new URL(await tunnel.listen())
    local.protocol = parsed.protocol
    local.pathname = parsed.pathname
    local.search = parsed.search
    localUrls.push(local.toString())
  }
  return { localUrls, close: async () => { await Promise.all([...tunnels.values()].map(tunnel => tunnel.close())) } }
}
