import { classifyHost, type TailnetClassification } from './tailscale.js'

/** 连接方式：tailnet（CGNAT/MagicDNS/短名）或 direct（普通域名/IP）。 */
export type LinkKind = 'tailnet' | 'direct'
export type LinkPreference = 'tailnet' | 'direct' | 'any'

export interface ServerEndpoint {
  url: string
  kind: LinkKind
}

const KIND_BY_CLASSIFICATION: Record<TailnetClassification, LinkKind> = { 'cgnat-ip': 'tailnet', 'magic-dns': 'tailnet', 'short-name': 'tailnet', other: 'direct' }

export function classifyEndpoint(url: string): ServerEndpoint {
  const host = new URL(url).hostname.toLowerCase()
  return { url, kind: KIND_BY_CLASSIFICATION[classifyHost(host)] }
}

/** 解析逗号/空白分隔的候选地址：去重、校验协议，至少返回一个合法 URL。 */
export function parseCandidateUrls(raw: string | undefined | null, fallback?: string): string[] {
  const list = [...(raw ?? '').split(/[,\s]+/), fallback ?? ''].map(part => part.trim().replace(/\/+$/, '')).filter(Boolean)
  const seen = new Set<string>()
  const urls: string[] = []
  for (const candidate of list) {
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`候选地址协议不支持：${candidate}`)
    if (url.username || url.password || url.hash) throw new Error(`候选地址包含非法部分：${candidate}`)
    const href = url.pathname === '/' ? url.origin : url.href
    if (!seen.has(href)) { seen.add(href); urls.push(href) }
  }
  return urls
}

/** 按 prefer 排序候选（稳定排序，any 保持注册顺序）。 */
export function orderEndpoints(urls: readonly string[], prefer: LinkPreference): ServerEndpoint[] {
  const endpoints = urls.map(classifyEndpoint)
  if (prefer === 'any') return endpoints
  return endpoints.filter(endpoint => endpoint.kind === prefer).concat(endpoints.filter(endpoint => endpoint.kind !== prefer))
}

export function parsePreference(raw: string | undefined | null): LinkPreference {
  return raw === 'tailnet' || raw === 'direct' ? raw : 'any'
}

/**
 * 未显式指定 prefer 时的自动策略：候选含 tailnet 地址才探测（零开销原则）；
 * 本机 tailscale CLI 可用 → 自动优先 tailnet，否则保持注册顺序（any）。
 */
export async function resolveAutoPreference(probe: import('./tailscale.js').TailscaleProbe, candidates: readonly string[]): Promise<{ prefer: LinkPreference; reason: string }> {
  const tailnetCandidates = candidates.filter(candidate => classifyEndpoint(candidate).kind === 'tailnet')
  if (tailnetCandidates.length === 0) return { prefer: 'any', reason: '候选地址中没有 tailnet 地址，保持注册顺序' }
  const { probeCli } = await import('./tailscale.js')
  const cli = await probeCli(probe)
  return cli.available
    ? { prefer: 'tailnet', reason: `检测到 tailscale CLI（${cli.version}），自动优先 tailnet 地址（${tailnetCandidates.join('、')}）` }
    : { prefer: 'any', reason: '候选含 tailnet 地址但本机未检测到 tailscale CLI，保持注册顺序' }
}
