import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tailscaleArgs } from './tailscale-command.js'

const execFileAsync = promisify(execFile)

/** 可注入的命令执行 seam：测试用假 probe，生产走 tailscale CLI。 */
export interface TailscaleProbe {
  run(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }>
}

export const defaultProbe: TailscaleProbe = {
  run: async (command, args, timeoutMs) => {
    const { stdout, stderr } = await execFileAsync(command, command === 'tailscale' ? tailscaleArgs(args) : args, { timeout: timeoutMs })
    return { stdout, stderr }
  },
}

export type TailnetClassification = 'cgnat-ip' | 'magic-dns' | 'short-name' | 'other'

/** 判定主机是否属于 Tailscale 地址空间：CGNAT 100.64.0.0/10、*.ts.net、单标签 MagicDNS 短名；localhost 与回环地址永不算。 */
export function classifyHost(host: string): TailnetClassification {
  const lower = host.toLowerCase().replace(/\.$/, '')
  if (lower === 'localhost' || /^127(\.\d{1,3}){3}$/.test(lower) || lower === '::1' || lower === '[::1]') return 'other'
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])(\.\d{1,3}){2}$/.test(lower)) return 'cgnat-ip'
  if (lower.endsWith('.ts.net')) return 'magic-dns'
  if (!lower.includes('.')) return 'short-name'
  return 'other'
}

export function isDefiniteTailnet(classification: TailnetClassification): boolean {
  return classification === 'cgnat-ip' || classification === 'magic-dns'
}

export interface TailscaleStatusInfo {
  state: string
  hostname: string
  dnsName: string
  selfIps: string[]
}

export function parseStatusJson(raw: string): TailscaleStatusInfo {
  const parsed = JSON.parse(raw) as { BackendState?: unknown; Self?: { HostName?: unknown; DNSName?: unknown; TailscaleIPs?: unknown } }
  const ips = Array.isArray(parsed.Self?.TailscaleIPs) ? parsed.Self.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string') : []
  return {
    state: typeof parsed.BackendState === 'string' ? parsed.BackendState : 'Unknown',
    hostname: typeof parsed.Self?.HostName === 'string' ? parsed.Self.HostName : '',
    dnsName: typeof parsed.Self?.DNSName === 'string' ? parsed.Self.DNSName.replace(/\.$/, '') : '',
    selfIps: ips,
  }
}

export interface TailscalePingResult {
  ok: boolean
  detail: string
}

export function parsePingOutput(stdout: string, stderr: string): TailscalePingResult {
  const first = stdout.split('\n').map(line => line.trim()).filter(Boolean)[0] ?? ''
  if (first.toLowerCase().startsWith('pong')) return { ok: true, detail: first }
  const failure = stderr.trim() || first || 'no reply'
  return { ok: false, detail: failure }
}

export interface TailscaleAvailability {
  available: boolean
  version: string
  error: string
}

/** 探测本机 tailscale CLI 是否可用（与后台 tailscaled 是否登录无关）。 */
export async function probeCli(probe: TailscaleProbe): Promise<TailscaleAvailability> {
  try {
    const { stdout } = await probe.run('tailscale', ['version'], 4000)
    const version = stdout.split('\n')[0]?.trim() ?? ''
    return { available: true, version, error: '' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { available: false, version: '', error: code === 'ENOENT' ? 'tailscale 命令未安装或不在 PATH' : error instanceof Error ? error.message : String(error) }
  }
}

export interface TailscaleReport {
  available: boolean
  version: string
  state: string
  hostname: string
  dnsName: string
  selfIps: string[]
}

/** 一次性采集本机 Tailscale 状态；CLI 缺失时 state 为 unavailable。 */
export async function reportTailscale(probe: TailscaleProbe): Promise<TailscaleReport> {
  const cli = await probeCli(probe)
  if (!cli.available) return { available: false, version: '', state: 'unavailable', hostname: '', dnsName: '', selfIps: [], }
  try {
    const { stdout } = await probe.run('tailscale', ['status', '--json', '--timeout=2s'], 5000)
    const info = parseStatusJson(stdout)
    return { available: true, version: cli.version, state: info.state, hostname: info.hostname, dnsName: info.dnsName, selfIps: info.selfIps }
  } catch (error) {
    return { available: true, version: cli.version, state: 'Unknown', hostname: '', dnsName: '', selfIps: [], }
  }
}

export type PreflightVerdict = 'ok' | 'warning' | 'error' | 'skip'

export interface TailnetPreflight {
  classification: TailnetClassification
  relevant: boolean
  verdict: PreflightVerdict
  message: string
  report: TailscaleReport | null
  ping: TailscalePingResult | null
}

/**
 * 注册/启动前对 server 地址做 Tailscale 预检：
 * - 地址不在 tailnet 空间 → skip（保持零开销）
 * - 地址在 tailnet 但本机 Tailscale 未运行 → error（注册时快速失败，给出可操作提示）
 * - 已运行 → tailscale ping 验证对端可达，不通只警告（可能仍在 DERP 握手）
 */
export async function preflightServer(probe: TailscaleProbe, serverUrlValue: string): Promise<TailnetPreflight> {
  let host: string
  try {
    host = new URL(serverUrlValue).hostname
  } catch {
    return { classification: 'other', relevant: false, verdict: 'skip', message: `无法解析服务端地址 ${serverUrlValue}`, report: null, ping: null }
  }
  const classification = classifyHost(host)
  // 普通域名/IP 零开销跳过：不碰 tailscale CLI（含 localhost 回环）。
  if (classification === 'other') return { classification, relevant: false, verdict: 'skip', message: '服务端地址不在 Tailscale 网段，跳过预检', report: null, ping: null }
  const report = await reportTailscale(probe)
  const relevant = isDefiniteTailnet(classification) || (classification === 'short-name' && report.state === 'Running')
  if (!relevant) return { classification, relevant: false, verdict: 'skip', message: '服务端地址不在 Tailscale 网段，跳过预检', report, ping: null }
  if (!report.available) return { classification, relevant: true, verdict: 'warning', message: '服务端地址位于 Tailscale 网络，但本机未检测到 tailscale 命令；将直接尝试连接', report, ping: null }
  if (report.state === 'Unknown') return { classification, relevant: true, verdict: 'warning', message: '无法确认 Tailscale 状态（请检查 WEMUX_TS_SOCKET 与 daemon）；保留候选地址并尝试实际连接', report, ping: null }
  if (report.state !== 'Running') return { classification, relevant: true, verdict: 'error', message: `Tailscale 状态为 ${report.state}，无法访问 tailnet；请先执行 tailscale up 并登录`, report, ping: null }
  try {
    const { stdout, stderr } = await probe.run('tailscale', ['ping', '--timeout=4s', host], 6000)
    const ping = parsePingOutput(stdout, stderr)
    return ping.ok
      ? { classification, relevant: true, verdict: 'ok', message: `Tailscale 预检通过（${ping.detail}）`, report, ping }
      : { classification, relevant: true, verdict: 'warning', message: `尚未 ping 通对端（${ping.detail}）；将通过网络直接尝试连接`, report, ping }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { classification, relevant: true, verdict: 'warning', message: `tailscale ping 失败（${detail}）；将通过网络直接尝试连接`, report, ping: null }
  }
}
