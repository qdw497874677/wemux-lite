import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, constants, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildWorkerTarball } from './build-worker-tarball.mjs'

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(packageDirectory, '..', '..')
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'wemux-lite-worker-package-'))
const prefix = join(temporaryDirectory, 'prefix')
mkdirSync(prefix, { recursive: true })

try {
  const { tarball } = buildWorkerTarball({ repositoryRoot, packDestination: temporaryDirectory })
  execFileSync('npm', ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', tarball, '--prefix', prefix], {
    cwd: temporaryDirectory,
    stdio: 'inherit',
  })

  for (const executable of ['wemux-lite-worker', 'wemux-lite-agent', 'wemux-lite-agent-mcp']) {
    accessSync(join(prefix, 'bin', executable), constants.X_OK)
  }
  const worker = join(prefix, 'bin', 'wemux-lite-worker')
  const version = execFileSync(worker, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  if (!/^wemux-lite-worker \d+\.\d+\.\d+\s*$/.test(version)) fail(`unexpected version output: ${version}`)
  execFileSync(worker, ['status', '--home', join(temporaryDirectory, 'home')], {
    stdio: 'ignore',
    timeout: 10_000,
  })

  const agent = spawnSync(join(prefix, 'bin', 'wemux-lite-agent'), [], { encoding: 'utf8', timeout: 10_000 })
  if (agent.status !== 1 || !agent.stderr.includes('Usage: wemux-lite-agent')) fail('wemux-lite-agent did not start and report its expected usage error')

  const mcp = spawnSync(join(prefix, 'bin', 'wemux-lite-agent-mcp'), [], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`,
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (mcp.status !== 0 || !mcp.stdout.includes('"name":"wemux-lite-agent"')) fail(`wemux-lite-agent-mcp failed its initialize handshake: ${mcp.stderr}`)

  const packageRoot = join(prefix, 'lib', 'node_modules', '@wemux', 'worker')
  const installedManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  if (installedManifest.dependencies?.['@earendil-works/pi-coding-agent']) fail('Worker must not install a Pi runtime')
  accessSync(join(packageRoot, 'web', 'index.html'))
  const webEntry = readFileSync(join(packageRoot, 'web', 'index.html'), 'utf8')
  const webAsset = webEntry.match(/\/assets\/([^"']+\.js)/)?.[1]
  if (!webAsset) fail('bundled Web entry point has no hashed JavaScript asset')
  accessSync(join(packageRoot, 'web', 'assets', webAsset))
  accessSync(join(packageRoot, 'node_modules', 'ws', 'package.json'))
  accessSync(join(packageRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'))
  const missingAgents = JSON.parse(execFileSync(process.execPath, [join(packageRoot, 'dist', 'cli.js'), 'detect', '--home', join(temporaryDirectory, 'no-agents')], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, PATH: '' },
  }))
  if (missingAgents.find(agent => agent.agentKey === 'pi')?.availability.status !== 'unavailable') fail('Worker must start detection successfully without Pi installed')
  const runtimeImports = javascriptFiles(join(packageRoot, 'dist'))
    .flatMap(file => {
      const content = readFileSync(file, 'utf8')
      return content.includes("from '@wemux/") || content.includes('from "@wemux/') ? [file] : []
    })
  const bundled = new Set(installedManifest.bundleDependencies ?? [])
  const unbundled = runtimeImports.filter(file => {
    const imports = [...readFileSync(file, 'utf8').matchAll(/from ['\"](@wemux\/[a-z-]+)['\"]/g)].map(match => match[1])
    return imports.some(name => !bundled.has(name))
  })
  if (unbundled.length) fail(`published JavaScript imports private packages outside bundleDependencies:\n${unbundled.join('\n')}`)
  for (const name of bundled) {
    accessSync(join(packageRoot, 'node_modules', '@wemux', name.replace('@wemux/', ''), 'package.json'))
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? javascriptFiles(path) : entry.name.endsWith('.js') ? [path] : []
  })
}

function fail(message) {
  throw new Error(message)
}
