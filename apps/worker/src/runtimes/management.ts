import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { runtimeKey, saveAgentSelection, type RuntimeKey } from '../config/agent-settings.js'

export interface ProcessRequest { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; timeout: number }
export type RuntimeProcess = (request: ProcessRequest) => Promise<string>
export const runRuntimeProcess: RuntimeProcess = request => new Promise((resolve, reject) => {
  const grouped = process.platform !== 'win32'
  const child = spawn(request.command, request.args, { cwd: request.cwd, env: request.env, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  const output: Buffer[] = []
  const sizes = { stdout: 0, stderr: 0 }
  let failure: Error | undefined
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const finish = () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    clearTimeout(cleanupTimer)
    child.stdout.destroy()
    child.stderr.destroy()
    child.unref()
    if (failure) reject(failure)
    else resolve(Buffer.concat(output).toString('utf8').trim())
  }
  const fail = (error: Error) => {
    if (failure || settled) return
    failure = error
    // Kill the dedicated group, even after its leader exits: lifecycle scripts
    // can still hold our pipes open. Never wait indefinitely for those pipes.
    try {
      if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch (killError) {
      if ((killError as NodeJS.ErrnoException).code !== 'ESRCH') failure = new AggregateError([error, killError], 'Runtime process cleanup failed')
    }
    cleanupTimer = setTimeout(finish, 1000)
  }
  const timer = setTimeout(() => fail(Object.assign(new Error('Runtime process timed out'), { code: 'ETIMEDOUT', killed: true })), request.timeout)
  for (const stream of ['stdout', 'stderr'] as const) {
    child[stream].on('data', (chunk: Buffer) => {
      if (failure) return
      sizes[stream] += chunk.length
      if (sizes[stream] > 1024 * 1024) {
        fail(Object.assign(new Error(`${stream} maxBuffer exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }))
      } else if (stream === 'stdout') output.push(chunk)
    })
  }
  child.on('error', fail)
  child.on('exit', (code, signal) => {
    if (code !== 0) fail(Object.assign(new Error(`Runtime process exited with ${code ?? signal}`), { code, signal }))
  })
  // Timeout remains armed until close, not merely until the npm parent exits.
  child.on('close', finish)
})

// Exact official registry releases, not user-controlled package specs or shell commands.
export const installCatalog = {
  pi: { name: '@earendil-works/pi-coding-agent', version: '0.85.1', bin: 'dist/bundle/cli.js', integrity: 'sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==' },
  opencode: { name: 'opencode-ai', version: '1.18.31', bin: 'bin/opencode.exe', integrity: 'sha512-J95feefeWwtIaw3irx76WjzWcgQXxmuHmDVphvs5ep9X30fBJ6T6bFhw50i9Kx50MG/xPn5w2pafXIfNtdry9w==' },
  'claude-code': { name: '@anthropic-ai/claude-code', version: '2.1.34', bin: 'cli.js', integrity: 'sha512-uQ3yv41lvCExj2Ju/pCZ1KIKub5d5V3RQyeSKICPoJzk/H2Ktp0zonZeLkD/Q56qa4vPpA8MmvsBmFkAr+Z42w==' },
} as const
export const installWarning = '警告：此操作将从 https://registry.npmjs.org 下载固定版本的官方 npm 包及依赖，可能执行包的安装脚本；需要网络并信任上游代码。仅安装到 Worker home，不使用全局安装、不覆盖已有 Agent。请明确提供 --yes。'
export const restartNotice = '选择已保存；正在运行的 Worker 不会热更新，请重启 Worker 后生效。Agent 登录/模型配置仍需单独完成。'

/** Match the exact release token, never accept 0.85.10 as 0.85.1. */
export function matchesRuntimeVersion(output: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^0-9.])${escaped}($|[^0-9.])`).test(output)
}

async function validateExecutable(executable: string, run: RuntimeProcess): Promise<string> {
  if (!isAbsolute(executable)) throw new Error('--path 必须是可执行文件的绝对路径（不是命令或参数）')
  if (!(await stat(executable)).isFile()) throw new Error('Agent 路径不是文件')
  await access(executable, constants.X_OK)
  const version = await run({ command: executable, args: ['--version'], timeout: 10_000 })
  if (!version.trim()) throw new Error('Agent --version 未返回版本；保留原有选择')
  return version.slice(0, 256)
}

export async function useAgent(home: string, value: string | undefined, executable: string | undefined, run: RuntimeProcess = runRuntimeProcess) {
  const key = runtimeKey(value)
  if (!executable) throw new Error('agent use 需要 --path 绝对路径')
  const version = await validateExecutable(executable, run)
  await saveAgentSelection(home, key, { executable, source: 'local', selectedAt: new Date().toISOString() })
  return { key, executable, source: 'local', version, message: restartNotice }
}

export async function installAgent(home: string, value: string | undefined, yes: boolean, run: RuntimeProcess = runRuntimeProcess, expectedIntegrity?: string) {
  if (!yes) throw new Error(installWarning)
  const result = await materializeAgentPackage(home, value, run, expectedIntegrity)
  try {
    await saveAgentSelection(home, result.key, { executable: result.executable, source: 'managed', package: result.package, selectedAt: new Date().toISOString() })
  } catch (error) {
    await rm(result.directory, { recursive: true, force: true })
    throw error
  }
  return { key: result.key, executable: result.executable, source: 'managed' as const, package: result.package, version: result.version, message: restartNotice }
}

/** Stage a fixed official runtime without changing the executable used by running Sessions. */
export async function stageAgentRuntime(home: string, artifact: { readonly packageName: string; readonly packageVersion: string; readonly registryOrigin: string; readonly packageIntegrity: string }, run: RuntimeProcess = runRuntimeProcess) {
  const entry = (Object.entries(installCatalog) as [keyof typeof installCatalog, (typeof installCatalog)[keyof typeof installCatalog]][]).find(([, spec]) => spec.name === artifact.packageName)
  if (!entry || artifact.packageVersion !== entry[1].version || artifact.registryOrigin !== 'https://registry.npmjs.org' || artifact.packageIntegrity !== entry[1].integrity) throw new Error('unapproved_runtime_artifact')
  return materializeAgentPackage(home, entry[0], run)
}

async function materializeAgentPackage(home: string, value: string | undefined, run: RuntimeProcess, expectedIntegrity?: string) {
  const key: RuntimeKey = runtimeKey(value)
  if (key !== 'pi' && key !== 'opencode' && key !== 'claude-code') throw new Error(`${key} 暂不支持托管安装；请自行安装后使用 agent use ${key} --path 绝对路径（目前仅检测，不支持执行）`)
  if (process.platform === 'win32') throw new Error('托管 npm 安装暂不支持 Windows；请在 WSL 使用，或通过 agent use 选择可直接执行的本地文件')
  const spec = installCatalog[key]
  const integrity = expectedIntegrity ?? spec.integrity
  const packageSpec = `${spec.name}@${spec.version}`
  const parent = join(home, 'agents', key)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  // Each attempt gets a fresh prefix: failed installs never mutate the selected runtime.
  const directory = await mkdtemp(join(parent, `${spec.version}-`))
  try {
    // Do not inherit registry (including scope overrides), script, or prefix settings.
    // Network proxies are intentionally supported; ordinary HTTP(S)_PROXY/NO_PROXY
    // variables remain in the environment too. User/global npmrc files are isolated.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_config_/i.test(name)))
    for (const [name, value] of Object.entries(process.env)) {
      if (/^npm_config_(proxy|https[-_]proxy|noproxy)$/i.test(name)) env[name.toLowerCase()] = value
    }
    const userconfig = join(directory, 'user.npmrc')
    const globalconfig = join(directory, 'global.npmrc')
    await writeFile(userconfig, '', { mode: 0o600 })
    await writeFile(globalconfig, '', { mode: 0o600 })
    env.npm_config_userconfig = userconfig
    env.npm_config_globalconfig = globalconfig
    // Download without running lifecycle scripts. Verify the immutable official
    // artifact bytes before npm is allowed to install or execute any package code.
    const packed = JSON.parse(await run({ command: 'npm', args: ['pack', '--json', '--ignore-scripts', '--pack-destination', directory, '--registry=https://registry.npmjs.org', '--', packageSpec], cwd: directory, env, timeout: 300_000 })) as unknown
    const expectedFilename = `${spec.name.replace(/^@/, '').replace('/', '-')}-${spec.version}.tgz`
    if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== 'string' || packed[0].filename !== expectedFilename) throw new Error('npm artifact metadata invalid; previous selection preserved')
    const artifact = join(directory, expectedFilename)
    if ((await stat(artifact)).size > 128 * 1024 * 1024) throw new Error('npm artifact size exceeds limit; previous selection preserved')
    const actualIntegrity = `sha512-${createHash('sha512').update(await readFile(artifact)).digest('base64')}`
    if (actualIntegrity !== integrity) throw new Error('npm artifact integrity mismatch; previous selection preserved')
    await run({ command: 'npm', args: ['install', '--global=false', '--prefix', directory, '--no-save', '--package-lock=false', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--', artifact], cwd: directory, env, timeout: 300_000 })
    const root = join(directory, 'node_modules', spec.name)
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const binName = key === 'pi' ? 'pi' : key === 'opencode' ? 'opencode' : 'claude'
    if (manifest.name !== spec.name || manifest.version !== spec.version || manifest.bin?.[binName] !== spec.bin) throw new Error('安装包名称、版本或入口与固定目录不匹配；保留原有选择')
    const executable = join(root, spec.bin)
    const version = await validateExecutable(executable, run)
    if (!matchesRuntimeVersion(version, spec.version)) throw new Error('Agent version probe does not match pinned artifact; previous selection preserved')
    return { key, executable, directory, package: packageSpec, version }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
