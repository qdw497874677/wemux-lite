import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, constants, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'wemux-lite-worker-package-'))
const packedDirectory = join(temporaryDirectory, 'packed')
const prefix = join(temporaryDirectory, 'prefix')
mkdirSync(packedDirectory)

try {
  execFileSync('npm', ['pack', '--pack-destination', packedDirectory], {
    cwd: packageDirectory,
    stdio: 'inherit',
  })
  const tarball = join(
    packedDirectory,
    readdirSync(packedDirectory).find(file => file.endsWith('.tgz')) ?? fail('npm pack did not create a tarball'),
  )
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
  accessSync(join(packageRoot, 'node_modules', 'ws', 'package.json'))
  const missingAgents = JSON.parse(execFileSync(process.execPath, [join(packageRoot, 'dist', 'cli.js'), 'detect', '--home', join(temporaryDirectory, 'no-agents')], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, PATH: '' },
  }))
  if (missingAgents.find(agent => agent.agentKey === 'pi')?.availability.status !== 'unavailable') fail('Worker must start detection successfully without Pi installed')
  const runtimeImports = javascriptFiles(join(packageRoot, 'dist'))
    .flatMap(file => {
      const content = readFileSync(file, 'utf8')
      return content.includes("from '@wemux/") || content.includes('from "@wemux/') ? [file] : []
    })
  if (runtimeImports.length) fail(`published JavaScript imports private packages:\n${runtimeImports.join('\n')}`)
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
