import { execFile } from 'node:child_process'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

/** 服务端所在主机的 Tailscale 自检结果，供注册弹窗向管理员推荐 tailnet 地址。 */
export interface TailnetSelfInfo {
  available: boolean
  state: string
  dnsName: string | null
  selfIps: string[]
  /** 本机对工作节点可达的 IPv4（含 tailnet 与局域网，已排除 docker/虚拟化网卡），供工作节点多候选连接。 */
  lanIps: string[]
  error?: string
}

export type TailnetRunner = (args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>

export const execRunner: TailnetRunner = (args, timeoutMs) => new Promise((resolve, reject) => {
  execFile('tailscale', args, { timeout: timeoutMs }, (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })))
})

/**
 * 仅本机可达的虚拟接口名：docker与容器桥（docker*、br-<12位hex>、veth*）、虚拟化 host-only（vmnet*、vboxnet*、virbr*）、
 * Windows Hyper-V（vEthernet*）、macOS VPN（utun*）、点对点隧道（tun*、tap*）及杂项虚拟设备。
 * 这些地址从工作节点不可达，混入候选会让安装命令臃肿且容错退化为逐个超时。
 * 注意：tailscale、zt、wg 等 overlay VPN 接口是真实可达的，不排除；br0、lan0 等系统桥可能承载物理流量，也不排除。
 */
const VIRTUAL_INTERFACE = /^(docker\d*|br-[0-9a-f]{12}|veth.*|vmnet\d+|vboxnet\d+|virbr\d*|vEthernet.*|utun\d+|tun\d*|tap\d*|dummy\d*|ifb\d+|gretap\d+)$/

/** 纯函数：从网卡枚举中选出其它主机真正可达的 IPv4（供测试）。 */
export function selectReachableIpv4(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const ips = new Set<string>()
  for (const [name, list] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue
      if (net.address.startsWith('169.254.')) continue
      ips.add(net.address)
    }
  }
  return [...ips]
}

/** 本机对工作节点可达的 IPv4（排除环回/链路本地/虚拟网卡），跨网卡枚举，不依赖 tailscale CLI。 */
function readLanIps(): string[] {
  return selectReachableIpv4(networkInterfaces())
}

let cache: { at: number; value: TailnetSelfInfo } | null = null
const DEFAULT_TTL_MS = 60_000

/**
 * 读取本机 tailscale status --json；CLI 缺失/未运行时返回 available:false 而不是抛错。
 * 结果缓存 60 秒，避免管理界面反复触发子进程。
 */
export async function readTailnetSelf(runner: TailnetRunner = execRunner, ttlMs = DEFAULT_TTL_MS): Promise<TailnetSelfInfo> {
  if (ttlMs > 0 && cache && Date.now() - cache.at < ttlMs) return cache.value
  let value: TailnetSelfInfo
  try {
    const { stdout } = await runner(['status', '--json'], 4000)
    const parsed = JSON.parse(stdout) as { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] } }
    value = {
      available: true,
      state: parsed.BackendState ?? 'Unknown',
      dnsName: (parsed.Self?.DNSName ?? '').replace(/\.$/, '') || null,
      selfIps: parsed.Self?.TailscaleIPs ?? [],
      lanIps: readLanIps(),
    }
  } catch (error) {
    value = { available: false, state: 'unavailable', dnsName: null, selfIps: [], lanIps: readLanIps(), error: (error as Error).message }
  }
  if (ttlMs > 0) cache = { at: Date.now(), value }
  return value
}
