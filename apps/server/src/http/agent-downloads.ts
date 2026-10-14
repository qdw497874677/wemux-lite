import type { ServerResponse } from 'node:http'
import { agentRegistryOrigin, agentRestartNotice, agentRuntimeCatalog, type ManagedAgentCatalogEntry, type ManagedAgentKey } from '@wemux/domain'

/**
 * 托管 Agent 安装的公开下载面：固定版本清单 + 一键安装脚本。
 *
 * 脚本只读取环境变量（WEMUX_AGENT_KEY / WEMUX_INSTALL_DIR / WEMUX_WORKER_HOME），
 * 不拼接任何管理员输入到 shell 中，因此没有命令注入面。真正的安装逻辑由一个内联的
 * node 驱动执行：先下载固定版本 tarball 并校验 sha512，校验通过后才允许 npm 安装，
 * 安装目录始终是 Worker home 内的独立目录（--global=false，不碰全局前缀），
 * 每次尝试使用全新的暂存目录，失败不会改动已选中/可用的运行时。
 *
 * 为什么不让脚本直接调用 Worker CLI：目标机器上的 Worker 安装路径未知，且 Worker 的
 * 托管安装固定走 https://registry.npmjs.org（改地址会破坏离线契约测试）。因此脚本把
 * 与 Worker 相同顺序、相同校验的物化流程内联执行，目录/版本/完整性摘要都来自
 * @wemux/domain 的同一份固定版本目录，Server 与 Worker 不会漂移。
 */

export const agentInstallerPath = '/downloads/install-agent.sh'
export const agentManifestPath = '/downloads/agent-manifest.json'

export interface AgentCatalogLike {
  readonly [key: string]: { readonly name: string; readonly version: string; readonly bin: string; readonly integrity: string }
}

export interface AgentDownloadOptions {
  /** 仅用于离线契约测试注入假 registry/假目录；HTTP 路径始终使用共享固定版本目录。 */
  readonly catalog?: AgentCatalogLike
  readonly registryOrigin?: string
}

export function agentCatalogEntries(catalog: AgentCatalogLike = agentRuntimeCatalog) {
  return (Object.keys(catalog) as ManagedAgentKey[]).map(key => ({ key, packageName: catalog[key].name, packageVersion: catalog[key].version, bin: catalog[key].bin, packageIntegrity: catalog[key].integrity }))
}

export interface AgentManifest {
  readonly schemaVersion: 1
  readonly registryOrigin: string
  readonly installerPath: string
  readonly manifestPath: string
  readonly installDirectoryRule: string
  readonly restartNotice: string
  readonly agents: readonly ManagedAgentCatalogEntry[]
}

export function agentManifest(options: AgentDownloadOptions = {}): AgentManifest {
  const catalog = options.catalog ?? agentRuntimeCatalog
  const registryOrigin = options.registryOrigin ?? agentRegistryOrigin
  return {
    schemaVersion: 1,
    registryOrigin,
    installerPath: agentInstallerPath,
    manifestPath: agentManifestPath,
    installDirectoryRule: 'WEMUX_INSTALL_DIR 必须是绝对路径且位于 WEMUX_WORKER_HOME 内（缺省 <WEMUX_WORKER_HOME>/agents/<key>）；每次安装落到该目录下的 <version>-<random> 子目录。',
    restartNotice: agentRestartNotice,
    agents: agentCatalogEntries(catalog),
  }
}

export function agentManifestBody(options: AgentDownloadOptions = {}): string {
  return JSON.stringify(agentManifest(options))
}

const DRIVER_HEADER = 'const CONSTANTS = '

/** POSIX sh 包装：只做 node 探测与驱动分发，不插值任何管理员输入。 */
function installerWrapper(driver: string): string {
  return [
    '#!/bin/sh',
    '# Wemux Lite 托管 Agent 安装脚本（固定版本 + sha512 校验）。',
    '# 用法：curl -fsSL <server>/downloads/install-agent.sh | WEMUX_AGENT_KEY=pi WEMUX_INSTALL_DIR=/abs/path WEMUX_WORKER_HOME=/abs/home sh',
    'set -eu',
    'if ! command -v node >/dev/null 2>&1; then',
    '  echo "wemux-agent-install: 64 需要 Node.js 22.13 或更高版本（未找到 node）" >&2',
    '  exit 69',
    'fi',
    'driver_dir=$(mktemp -d) || exit 69',
    'trap \'rm -rf "$driver_dir"\' EXIT INT TERM',
    'driver="$driver_dir/install-agent.mjs"',
    'cat > "$driver" <<\'WEMUX_AGENT_DRIVER\'',
    driver,
    'WEMUX_AGENT_DRIVER',
    'exec node "$driver" </dev/null',
    '',
  ].join('\n')
}

// 驱动源刻意不使用模板字符串与 ${}：它被原样写入 heredoc，任何插值都会破坏脚本字面量。
const DRIVER = String.raw`
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'

const MARKER = '.wemux-managed-agent.json'
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024
const NPM_TIMEOUT = 300000
let activeStaging = null

function fail(code, message) {
  const error = new Error(message)
  error.exitCode = code
  throw error
}

function describe(result) {
  if (result && result.error) return String(result.error.message || result.error)
  const stderr = result && typeof result.stderr === 'string' ? result.stderr.trim() : ''
  const tail = stderr.length > 400 ? stderr.slice(-400) : stderr
  return 'exit ' + String(result && result.status) + (tail ? '；' + tail.replace(/\n+/g, ' | ') : '')
}

function requireNode() {
  const parts = String(process.versions.node).split('.').map(Number)
  if (!(parts[0] > 22 || (parts[0] === 22 && parts[1] >= 13))) fail(69, '需要 Node.js 22.13 或更高版本，当前为 ' + process.versions.node)
}

function probeExecutable(executable, env) {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(executable, ['--version'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let output = ''
    let failure = null
    const timer = setTimeout(() => {
      failure = failure || '超时'
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { child.kill('SIGKILL') }
    }, 10000)
    child.stdout.on('data', chunk => { if (output.length < 65536) output += chunk })
    child.stderr.on('data', () => undefined)
    child.on('error', error => { failure = failure || error.message })
    child.on('close', code => {
      clearTimeout(timer)
      if (failure) return rejectProbe(new Error('版本探测失败：' + failure))
      if (code !== 0) return rejectProbe(new Error('Agent --version 返回 ' + code))
      resolveProbe(output.trim())
    })
  })
}

function versionMatches(output, version) {
  const escaped = version.replace(/[\\^$.*+?(){}|[\]]/g, '\\$&')
  return new RegExp('(^|[^0-9.])' + escaped + '($|[^0-9.])').test(output)
}

/** 目的目录必须严格位于 Worker home 内，且路径中的任何一段都不得是符号链接。 */
async function resolveDestination(key, spec) {
  const home = String(process.env.WEMUX_WORKER_HOME || '').trim()
  if (!home) fail(64, '缺少 WEMUX_WORKER_HOME；Worker 需要它记录托管选择，重启后才会拾取')
  if (!isAbsolute(home)) fail(64, 'WEMUX_WORKER_HOME 必须是绝对路径：' + home)
  let homeInfo
  try { homeInfo = await stat(home) } catch (error) { fail(64, 'WEMUX_WORKER_HOME 不存在：' + home) }
  if (!homeInfo.isDirectory()) fail(64, 'WEMUX_WORKER_HOME 不是目录：' + home)
  const realHome = await realpath(home)

  const requested = String(process.env.WEMUX_INSTALL_DIR || '').trim()
  const directory = requested || join(realHome, 'agents', key)
  if (!isAbsolute(directory)) fail(64, 'WEMUX_INSTALL_DIR 必须是绝对路径：' + directory)
  const target = resolve(directory)
  if (target === sep) fail(68, '安装目录不能是文件系统根目录')
  const allowExternal = /^(1|yes|true)$/i.test(String(process.env.WEMUX_ALLOW_EXTERNAL_INSTALL_DIR || '').trim())
  if (!allowExternal && !target.startsWith(realHome + sep)) {
    fail(68, '安装目录必须位于 WEMUX_WORKER_HOME 内：' + target + '；如确需安装到外部目录，请显式设置 WEMUX_ALLOW_EXTERNAL_INSTALL_DIR=yes')
  }
  if (target.startsWith(realHome + sep)) {
    let probe = realHome
    for (const part of target.slice(realHome.length + 1).split(sep)) {
      probe = join(probe, part)
      let info = null
      try { info = await lstat(probe) } catch (error) { info = null }
      if (info && info.isSymbolicLink()) fail(68, '安装目录路径包含符号链接：' + probe)
    }
  }
  return { realHome, target }
}

async function recordSelection(home, key, executable, spec) {
  const lockPath = join(home, 'agents.lock')
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') fail(70, '另一个 Agent 选择变更正在进行中：' + lockPath)
    fail(70, '无法获取选择锁 ' + lockPath + '：' + error.message)
  })
  const temporary = join(home, 'agents.' + process.pid + '.' + Date.now() + '.tmp')
  try {
    const path = join(home, 'agents.json')
    let settings = {}
    try {
      const raw = await readFile(path, 'utf8')
      if (raw.trim()) settings = JSON.parse(raw)
    } catch (error) {
      if (error.code !== 'ENOENT') fail(70, '现有 agents.json 无法读取，拒绝覆盖：' + error.message)
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) fail(70, '现有 agents.json 结构异常，拒绝覆盖')
    settings[key] = { executable, source: 'managed', package: spec.name + '@' + spec.version, selectedAt: new Date().toISOString() }
    await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await lock.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    await rm(lockPath, { force: true }).catch(() => undefined)
  }
}

async function main() {
  if (process.platform === 'win32') fail(64, '托管安装暂不支持 Windows；请在 WSL 中运行')
  const catalog = CONSTANTS.catalog
  const registryOrigin = CONSTANTS.registryOrigin
  const keys = Object.keys(catalog)
  const requestedKey = String(process.env.WEMUX_AGENT_KEY || '').trim()
  const key = requestedKey === 'claude' ? 'claude-code' : requestedKey
  if (!key) fail(64, '缺少 WEMUX_AGENT_KEY；可选：' + keys.join('、'))
  if (!Object.prototype.hasOwnProperty.call(catalog, key)) fail(64, '不支持的 WEMUX_AGENT_KEY：' + requestedKey + '；可选：' + keys.join('、'))
  const spec = catalog[key]
  const binName = key === 'pi' ? 'pi' : key === 'opencode' ? 'opencode' : 'claude'

  const { realHome, target } = await resolveDestination(key, spec)
  process.stderr.write('警告：将从 ' + registryOrigin + ' 下载固定版本官方包 ' + spec.name + '@' + spec.version + '。仅安装到独立目录，不使用全局安装、不修改系统 npm 前缀、不覆盖已有选择。\n')

  // 目的目录只作为安装根；每次尝试都在其下新建 <version>-<random> 暂存目录。
  await mkdir(target, { recursive: true, mode: 0o700 }).catch(error => fail(68, '无法创建安装目录 ' + target + '：' + error.message))
  const staging = await mkdtemp(join(target, spec.version + '-')).catch(error => fail(68, '无法创建暂存目录：' + error.message))
  activeStaging = staging
  const npmEnv = Object.fromEntries(Object.entries(process.env).filter(entry => !/^npm_config_/i.test(entry[0])))
  for (const [name, value] of Object.entries(process.env)) {
    if (/^npm_config_(proxy|https[-_]proxy|noproxy)$/i.test(name)) npmEnv[name.toLowerCase()] = value
  }
  npmEnv.npm_config_userconfig = join(staging, 'user.npmrc')
  npmEnv.npm_config_globalconfig = join(staging, 'global.npmrc')
  await writeFile(npmEnv.npm_config_userconfig, '', { mode: 0o600 })
  await writeFile(npmEnv.npm_config_globalconfig, '', { mode: 0o600 })
  await writeFile(join(staging, MARKER), JSON.stringify({ key, package: spec.name + '@' + spec.version, integrity: spec.integrity, registryOrigin, installRoot: target, installedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })

  const npm = String(process.env.WEMUX_NPM_BIN || 'npm')
  const npmProbe = spawnSync(npm, ['--version'], { encoding: 'utf8', env: npmEnv, timeout: 60000 })
  if (npmProbe.error || npmProbe.status !== 0) fail(69, '需要可用的 npm CLI（' + npm + '）：' + describe(npmProbe))

  process.stdout.write('wemux-agent-install: [1/4] 下载固定版本官方包（不执行生命周期脚本）\n')
  const packed = spawnSync(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', staging, '--registry=' + registryOrigin, '--', spec.name + '@' + spec.version], { cwd: staging, encoding: 'utf8', env: npmEnv, timeout: NPM_TIMEOUT, maxBuffer: 64 * 1024 * 1024 })
  if (packed.error || packed.status !== 0) fail(67, 'npm pack 失败：' + describe(packed))
  let metadata = null
  try { metadata = JSON.parse(packed.stdout) } catch (error) { metadata = null }
  const filename = spec.name.replace(/^@/, '').replace(/\//g, '-') + '-' + spec.version + '.tgz'
  if (!Array.isArray(metadata) || metadata.length !== 1 || !metadata[0] || metadata[0].filename !== filename) fail(67, 'npm 产物与固定版本不匹配（期望 ' + filename + '）')
  const artifact = join(staging, filename)
  let size = 0
  try { size = (await stat(artifact)).size } catch (error) { fail(67, '找不到 npm 产物 ' + artifact) }
  if (size > MAX_ARTIFACT_BYTES) fail(67, 'npm 产物超过 128MiB 上限')

  process.stdout.write('wemux-agent-install: [2/4] 校验 sha512 完整性（未通过则不安装任何代码）\n')
  const integrity = 'sha512-' + createHash('sha512').update(await readFile(artifact)).digest('base64')
  if (integrity !== spec.integrity) fail(65, '完整性校验失败：期望 ' + spec.integrity + '，实际 ' + integrity + '；已放弃安装')

  process.stdout.write('wemux-agent-install: [3/4] 安装到 ' + staging + '（--global=false，不使用全局前缀）\n')
  const installed = spawnSync(npm, ['install', '--global=false', '--prefix', staging, '--no-save', '--package-lock=false', '--no-audit', '--no-fund', '--registry=' + registryOrigin, '--', artifact], { cwd: staging, encoding: 'utf8', env: npmEnv, timeout: NPM_TIMEOUT, maxBuffer: 64 * 1024 * 1024 })
  if (installed.error || installed.status !== 0) fail(67, 'npm install 失败：' + describe(installed))

  const root = join(staging, 'node_modules', spec.name)
  let manifest = null
  try { manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) } catch (error) { fail(66, '无法读取安装清单：' + error.message) }
  if (!manifest || manifest.name !== spec.name || manifest.version !== spec.version || !manifest.bin || manifest.bin[binName] !== spec.bin) fail(66, '安装包名称、版本或入口与固定目录不匹配')

  process.stdout.write('wemux-agent-install: [4/4] 探测版本 ' + join(root, spec.bin) + '\n')
  const executable = join(root, spec.bin)
  await access(executable, constants.X_OK).catch(() => fail(66, '安装后的入口不可执行：' + executable))
  const probeEnv = Object.assign({}, process.env)
  if (key === 'pi') delete probeEnv.PI_PACKAGE_DIR
  const version = await probeExecutable(executable, probeEnv).catch(error => fail(66, error.message))
  if (!version) fail(66, 'Agent --version 未返回版本')
  if (!versionMatches(version, spec.version)) fail(66, '版本探测结果 ' + version + ' 与固定版本 ' + spec.version + ' 不一致')

  await recordSelection(realHome, key, executable, spec)
  process.stdout.write('wemux-agent-install: 托管安装完成：' + key + ' → ' + executable + '\n')
  process.stdout.write('wemux-agent-install: ' + CONSTANTS.restartNotice + '\n')

  return staging
}

requireNode()
main().then(() => undefined, error => {
  // 失败只清理本次暂存目录：已选中/可用的运行时与 agents.json 都不受影响。
  const code = typeof error.exitCode === 'number' ? error.exitCode : 70
  const finish = () => {
    process.stderr.write('wemux-agent-install: ' + code + ' ' + (error && error.message ? error.message : String(error)) + '\n')
    process.exit(code)
  }
  const staging = activeStaging
  activeStaging = null
  if (staging) rm(staging, { recursive: true, force: true }).then(finish, finish)
  else finish()
})
`

export function agentInstallScript(options: AgentDownloadOptions = {}): string {
  const catalog = options.catalog ?? agentRuntimeCatalog
  const registryOrigin = options.registryOrigin ?? agentRegistryOrigin
  const constants = JSON.stringify({ catalog, registryOrigin, restartNotice: agentRestartNotice })
  const driver = DRIVER_HEADER + constants + '\n' + DRIVER
  if (driver.includes('WEMUX_AGENT_DRIVER')) throw new Error('agent_install_driver_delimiter_conflict')
  return installerWrapper(driver)
}

export async function serveAgentDownload(response: ServerResponse, path: string, options: AgentDownloadOptions = {}): Promise<boolean> {
  if (path === agentInstallerPath) {
    const body = agentInstallScript(options)
    response.writeHead(200, {
      'Content-Type': 'text/x-shellscript; charset=utf-8',
      'Content-Disposition': 'inline; filename="install-agent.sh"',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(body)
    return true
  }
  if (path === agentManifestPath) {
    const body = agentManifestBody(options)
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(body)
    return true
  }
  return false
}
