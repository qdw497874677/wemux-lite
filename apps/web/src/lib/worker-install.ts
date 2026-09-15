import { ncDownloadScript } from '@wemux/web-contract'

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

/** 私网/环回/tailnet(CGNAT 100.64/10) 主机：这些地址全局 HTTP 代理必然路由不了，默认绕过代理直连。 */
const DIRECT_HOST = /^(localhost(\.domain)?$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/

function curlLine(url: string, indent: string, terminator: string): string {
  const host = new URL(url).hostname
  const noproxy = DIRECT_HOST.test(host) ? ` --noproxy ${shellQuote(host)}` : ''
  const scriptUrl = `${url.replace(/\/+$/, '')}/downloads/install-worker.sh`
  return `${indent}curl -fsSL --connect-timeout 5 ${shellQuote(scriptUrl)}${noproxy} ${terminator}`
}

function ncLine(url: string, indent: string, terminator: string): string {
  const { hostname, port } = new URL(url)
  const hostPort = port || '80'
  return `${indent}node -e ${shellQuote(ncDownloadScript)} ${shellQuote(hostname)} ${shellQuote(hostPort)} ${shellQuote('/downloads/install-worker.sh')} "$d/install.sh" ${terminator}`
}

/**
 * A single paste-able command, kept as short as industry norms (`curl -fsSL … | sh`):
 * - no `--proto` pinning: on LAN/tailnet HTTP deployments the redirect-protocol
 *   hardening costs 56 chars per candidate line for negligible threat coverage;
 * - multi-candidate deployments emit a fallback group (`{ curl A || curl B; }`)
 *   so the installer download survives an unreachable first address — the
 *   redundant WEMUX_SERVER_URL is dropped because the installer derives the
 *   primary URL from WEMUX_SERVER_URLS itself;
 * - private/tailnet hosts get `--noproxy` because global HTTP proxies cannot
 *   route them and would otherwise stall the download for minutes;
 * - transport="nc" downloads to a temporary file via `tailscale nc`, checks
 *   completeness, then executes it. It never streams partial scripts to sh.
 * All deployment-specific values travel as environment variables.
 */
export function buildWorkerInstallCommand(input: { token: string; serverUrl: string; workerName: string; serverUrls?: string[]; prefer?: 'tailnet' | 'direct' | 'any'; transport?: 'direct' | 'nc' }): string {
  const all = input.serverUrls ?? [input.serverUrl]
  const httpOnly = all.filter(url => url.startsWith('http://'))
  // nc 隧道只支持明文 http：无 http 候选时回退直连，避免生成必败命令
  const transport = input.transport === 'nc' && httpOnly.length > 0 ? 'nc' : 'direct'
  const usable = transport === 'nc' ? httpOnly : all
  const candidates = usable.length > 1 ? usable : null
  const primary = usable[0] ?? input.serverUrl
  const line = transport === 'nc' ? ncLine : curlLine
  const prefer = input.prefer && input.prefer !== 'any' ? input.prefer : null
  const lines: string[] = []
  if (candidates) {
    lines.push(line(candidates[0], '{ ', '\\'))
    candidates.slice(1).forEach((url, index) => lines.push(line(url, '  || ', index === candidates.length - 2 ? '; } \\' : '\\')))
  } else {
    lines.push(line(primary, '', '\\'))
  }
  const env = [
    ...(candidates ? [`WEMUX_SERVER_URLS=${shellQuote(candidates.join(','))}`] : [`WEMUX_SERVER_URL=${shellQuote(primary)}`, `WEMUX_SERVER_URLS=${shellQuote(primary)}`]),
    ...(prefer ? [`WEMUX_PREFER=${shellQuote(prefer)}`] : []),
    ...(transport === 'nc' ? [`WEMUX_TRANSPORT=${shellQuote('nc')}`] : []),
    `WEMUX_ENROLLMENT_TOKEN=${shellQuote(input.token)}`,
    `WEMUX_WORKER_NAME=${shellQuote(input.workerName)}`,
  ]
  if (transport === 'nc') {
    // Do not pipe a failed/partial download to sh: POSIX pipelines hide the
    // downloader exit status and may execute an incomplete installer.
    return [
      '( d=$(mktemp -d) || exit 1',
      '  trap \'rm -rf "$d"\' EXIT',
      '  trap \'exit 1\' HUP INT TERM',
      `  ${usable.map(url => ncLine(url, '', '')).join(' || ')} || exit 1`,
      `  ${env.join(' ')} sh "$d/install.sh"`,
      ')',
    ].join('\n')
  }
  lines.push(`  | ${env.join(' ')} sh`)
  return lines.join('\n')
}
