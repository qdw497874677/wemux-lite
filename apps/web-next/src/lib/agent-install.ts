import { ncDownloadScript } from '@wemux/web-contract'

/**
 * 托管 Agent 一键安装命令（离线/自托管路径）。
 *
 * 生成规则与 Worker 安装命令一致：私有/环回/tailnet 地址绕全局代理，多候选生成回退组，
 * nc 传输先落盘再执行（绝不把半截脚本喂给 sh），所有部署相关值只作为环境变量传递。
 * 与 Server 的同一份约束：安装目录必须是 Worker home 内的绝对路径，越出 home 需要显式
 * 打开 WEMUX_ALLOW_EXTERNAL_INSTALL_DIR，符号链接一律拒绝（在脚本内检查）。
 *
 * 这里只生成命令文本：展示命令不等于已安装，安装状态只能由 Worker 回执推进。
 */
export type ManagedAgentInstallIssueCode =
  | 'server_url_invalid'
  | 'agent_key_unsupported'
  | 'worker_home_required'
  | 'worker_home_not_absolute'
  | 'install_dir_required'
  | 'install_dir_not_absolute'
  | 'install_dir_outside_worker_home'

export interface ManagedAgentInstallIssue {
  readonly code: ManagedAgentInstallIssueCode
  readonly message: string
}

export interface ManagedAgentInstallInput {
  readonly serverUrl: string
  readonly serverUrls?: readonly string[]
  readonly agentKey: string
  readonly installDir: string
  readonly workerHome: string
  /** Server 提供的固定版本目录键；给出时会拒绝不在目录内的 Agent。 */
  readonly agentKeys?: readonly string[]
  readonly transport?: 'direct' | 'nc'
  readonly allowExternalInstallDir?: boolean
}

export interface ManagedAgentInstallCommand {
  readonly command: string
  readonly candidates: readonly string[]
  readonly transport: 'direct' | 'nc'
  readonly issues: readonly ManagedAgentInstallIssue[]
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

/** 私网/环回/tailnet(CGNAT 100.64/10) 主机：全局 HTTP 代理必然路由不了这些地址。 */
const DIRECT_HOST = /^(localhost$|.*\.localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/

/** `$HOME` 是唯一允许远端展开的前缀；其余路径一律单引号包裹，绝不进入 shell 语法。 */
export function remotePath(value: string): string {
  if (value === '$HOME') return '"$HOME"'
  if (value.startsWith('$HOME/')) return `"$HOME"${shellQuote(value.slice('$HOME'.length))}`
  return shellQuote(value)
}

const isRemoteAbsolute = (value: string) => /^\//.test(value) || value === '$HOME' || value.startsWith('$HOME/')

const installScriptPath = '/downloads/install-agent.sh'

/** 只接受 http/https 且有主机名的候选：`new URL('fe80::1:8010')` 会被当成 scheme `fe80:`，不能靠“可解析”判定。 */
const isHttpCandidate = (url: string) => {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== ''
  } catch { return false }
}

function candidatesOf(input: ManagedAgentInstallInput): string[] {
  return (input.serverUrls?.length ? [...input.serverUrls] : [input.serverUrl]).filter(isHttpCandidate)
}

export function managedAgentInstallIssues(input: ManagedAgentInstallInput): ManagedAgentInstallIssue[] {
  const issues: ManagedAgentInstallIssue[] = []
  if (candidatesOf(input).length === 0) issues.push({ code: 'server_url_invalid', message: '需要可访问的 Server 地址（http 或 https）。' })
  if (!input.agentKey || (input.agentKeys && !input.agentKeys.includes(input.agentKey))) issues.push({ code: 'agent_key_unsupported', message: '该 Agent 不在 Server 的固定版本目录内，不能托管安装。' })
  const homeAbsolute = isRemoteAbsolute(input.workerHome)
  if (!input.workerHome) issues.push({ code: 'worker_home_required', message: '必须提供 Worker home 目录。' })
  else if (!homeAbsolute) issues.push({ code: 'worker_home_not_absolute', message: 'Worker home 必须是绝对路径（可用 $HOME 前缀）。' })
  const dirAbsolute = isRemoteAbsolute(input.installDir)
  if (!input.installDir) issues.push({ code: 'install_dir_required', message: '必须提供安装目录。' })
  else if (!dirAbsolute) issues.push({ code: 'install_dir_not_absolute', message: '安装目录必须是绝对路径（可用 $HOME 前缀）。' })
  else if (homeAbsolute && !input.allowExternalInstallDir && input.installDir !== input.workerHome && !input.installDir.startsWith(`${input.workerHome.replace(/\/+$/, '')}/`)) {
    issues.push({ code: 'install_dir_outside_worker_home', message: '安装目录必须位于 Worker home 内；如确需外部目录，请显式允许（脚本会要求 WEMUX_ALLOW_EXTERNAL_INSTALL_DIR）。' })
  }
  return issues
}

function curlLine(url: string, indent: string, terminator: string): string {
  let host = ''
  try { host = new URL(url).hostname } catch { /* 非法候选：渲染期绝不抛出 */ }
  const noproxy = host && DIRECT_HOST.test(host) ? ` --noproxy ${shellQuote(host)}` : ''
  const scriptUrl = `${url.replace(/\/+$/, '')}${installScriptPath}`
  return `${indent}curl -fsSL --connect-timeout 5 ${shellQuote(scriptUrl)}${noproxy} ${terminator}`
}

function ncLine(url: string): string {
  let hostname = '', port = ''
  try { ({ hostname, port } = new URL(url)) } catch { /* 同上：宁出废行不出崩溃 */ }
  return `node -e ${shellQuote(ncDownloadScript)} ${shellQuote(hostname)} ${shellQuote(port || '80')} ${shellQuote(installScriptPath)} "$d/install.sh"`
}

export function buildManagedAgentInstallCommand(input: ManagedAgentInstallInput): ManagedAgentInstallCommand {
  const issues = managedAgentInstallIssues(input)
  const all = candidatesOf(input)
  const httpOnly = all.filter(url => url.startsWith('http://'))
  // nc 隧道只支持明文 http：无 http 候选时回退直连，避免生成必败命令。
  const transport: 'direct' | 'nc' = input.transport === 'nc' && httpOnly.length > 0 ? 'nc' : 'direct'
  if (issues.length) return { command: '', candidates: all, transport, issues }
  const usable = transport === 'nc' ? httpOnly : all
  const candidates = usable.length > 1 ? usable : null
  const primary = usable[0] ?? input.serverUrl
  const env = [
    `WEMUX_AGENT_KEY=${shellQuote(input.agentKey)}`,
    `WEMUX_INSTALL_DIR=${remotePath(input.installDir)}`,
    `WEMUX_WORKER_HOME=${remotePath(input.workerHome)}`,
    ...(input.allowExternalInstallDir ? [`WEMUX_ALLOW_EXTERNAL_INSTALL_DIR=${shellQuote('yes')}`] : []),
  ]
  if (transport === 'nc') {
    return {
      command: [
        '( d=$(mktemp -d) || exit 1',
        '  trap \'rm -rf "$d"\' EXIT',
        '  trap \'exit 1\' HUP INT TERM',
        `  ${usable.map(url => ncLine(url)).join(' || ')} || exit 1`,
        `  ${env.join(' ')} sh "$d/install.sh"`,
        ')',
      ].join('\n'),
      candidates: usable,
      transport,
      issues,
    }
  }
  const lines: string[] = []
  if (candidates) {
    lines.push(curlLine(candidates[0], '{ ', '\\'))
    candidates.slice(1).forEach((url, index) => lines.push(curlLine(url, '  || ', index === candidates.length - 2 ? '; } \\' : '\\')))
  } else {
    lines.push(curlLine(primary, '', '\\'))
  }
  lines.push(`  | ${env.join(' ')} sh`)
  return { command: lines.join('\n'), candidates: usable, transport, issues }
}

/** 缺省安装目录建议：Worker home 下的独立目录，绝不写全局 npm 前缀。 */
export const defaultAgentInstallDirectory = (workerHome: string, agentKey: string): string => `${workerHome.replace(/\/+$/, '')}/agents/${agentKey}`
