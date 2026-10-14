/**
 * 托管 Agent 运行时的固定版本目录（Server 与 Worker 共用的唯一来源）。
 *
 * 这里只登记官方 npm 包的确切版本与完整性摘要：Server 据此生成安装脚本与资源修订，
 * Worker 据此校验下发的 artifact。任何一方都不得各自维护副本，否则会出现
 * 「Server 允许分发、Worker 拒绝物化」的漂移。
 */

export const agentRegistryOrigin = 'https://registry.npmjs.org'

export const agentRuntimeCatalog = {
  pi: {
    name: '@earendil-works/pi-coding-agent',
    version: '0.85.1',
    bin: 'dist/bundle/cli.js',
    integrity: 'sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==',
  },
  opencode: {
    name: 'opencode-ai',
    version: '1.18.31',
    bin: 'bin/opencode.exe',
    integrity: 'sha512-J95feefeWwtIaw3irx76WjzWcgQXxmuHmDVphvs5ep9X30fBJ6T6bFhw50i9Kx50MG/xPn5w2pafXIfNtdry9w==',
  },
  'claude-code': {
    name: '@anthropic-ai/claude-code',
    version: '2.1.34',
    bin: 'cli.js',
    integrity: 'sha512-uQ3yv41lvCExj2Ju/pCZ1KIKub5d5V3RQyeSKICPoJzk/H2Ktp0zonZeLkD/Q56qa4vPpA8MmvsBmFkAr+Z42w==',
  },
} as const

export type ManagedAgentKey = keyof typeof agentRuntimeCatalog
export type ManagedAgentSpec = (typeof agentRuntimeCatalog)[ManagedAgentKey]

/** 目录自身的键顺序即为管理面展示顺序；从目录派生，避免出现第二份清单。 */
export const managedAgentKeys = Object.keys(agentRuntimeCatalog) as readonly ManagedAgentKey[]

/** 集群下发的 artifact 形状；与 `ResourceRevisionPayload` 的 artifact 分支字段一致。 */
export interface ManagedAgentArtifact {
  readonly packageName: string
  readonly packageVersion: string
  readonly registryOrigin: string
  readonly packageIntegrity: string
}

export interface ManagedAgentCatalogEntry {
  readonly key: ManagedAgentKey
  readonly packageName: string
  readonly packageVersion: string
  readonly bin: string
  readonly packageIntegrity: string
}

export function managedAgentCatalogEntries(): readonly ManagedAgentCatalogEntry[] {
  return managedAgentKeys.map(key => ({
    key,
    packageName: agentRuntimeCatalog[key].name,
    packageVersion: agentRuntimeCatalog[key].version,
    bin: agentRuntimeCatalog[key].bin,
    packageIntegrity: agentRuntimeCatalog[key].integrity,
  }))
}

/** `claude` 是命令行惯用写法，仓库内部的 agent key 是 `claude-code`。 */
export function normalizeManagedAgentKey(value: string | null | undefined): ManagedAgentKey | null {
  const key = value === 'claude' ? 'claude-code' : value
  return managedAgentKeys.includes(key as ManagedAgentKey) ? key as ManagedAgentKey : null
}

/**
 * 只有与固定目录逐字段相符、且来自受信 registry 的 artifact 才允许物化。
 * 返回 null 表示拒绝，调用方据此给出 `unapproved_runtime_artifact`。
 */
export function approvedAgentRuntime(artifact: ManagedAgentArtifact): { readonly key: ManagedAgentKey; readonly spec: ManagedAgentSpec } | null {
  if (artifact.registryOrigin !== agentRegistryOrigin) return null
  const key = managedAgentKeys.find(candidate => agentRuntimeCatalog[candidate].name === artifact.packageName)
  if (!key) return null
  const spec = agentRuntimeCatalog[key]
  if (artifact.packageVersion !== spec.version || artifact.packageIntegrity !== spec.integrity) return null
  return { key, spec }
}

/** Match the exact release token, never accept 0.85.10 as 0.85.1. */
export function matchesAgentRuntimeVersion(output: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^0-9.])${escaped}($|[^0-9.])`).test(output)
}

export const agentInstallWarning = '警告：此操作将从 https://registry.npmjs.org 下载固定版本的官方 npm 包及依赖，可能执行包的安装脚本；需要网络并信任上游代码。仅安装到 Worker home，不使用全局安装、不覆盖已有 Agent。请明确提供 --yes。'
export const agentRestartNotice = '选择已保存；正在运行的 Worker 不会热更新，请重启 Worker 后生效。Agent 登录/模型配置仍需单独完成。'

/** 托管安装建议目录（相对 Worker home）。脚本与服务端提示共用同一条规则。 */
export function managedAgentDefaultDirectory(key: ManagedAgentKey): string {
  return `agents/${key}`
}
