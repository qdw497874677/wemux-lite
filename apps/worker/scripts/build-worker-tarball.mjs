import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Builds a self-contained @wemux/worker tarball.
//
// npm does not embed workspace-linked dependencies declared in bundleDependencies
// (symlinked workspace packages are skipped), so the @wemux/* dependency closure is
// injected into package/node_modules manually, producing the same layout npm creates
// for registry-hosted bundled dependencies.
export function buildWorkerTarball({ repositoryRoot, packDestination }) {
  const workerRoot = join(repositoryRoot, 'apps', 'worker')
  const staging = mkdtempSync(join(packDestination, 'wemux-pack-'))
  const webRoot = join(repositoryRoot, 'apps', 'web', 'dist')
  if (!existsSync(join(webRoot, 'index.html')) || !existsSync(join(webRoot, 'assets'))) throw new Error('Web dist is missing; run npm run build --workspace @wemux/web first')
  rmSync(join(workerRoot, 'web'), { recursive: true, force: true })
  cpSync(webRoot, join(workerRoot, 'web'), { recursive: true })
  execFileSync('npm', ['pack', '--workspace', '@wemux/worker', '--pack-destination', staging], { cwd: repositoryRoot, stdio: 'inherit' })
  const candidates = readdirSync(staging).filter(entry => /^wemux-worker-.*\.tgz$/.test(entry))
  if (candidates.length !== 1) throw new Error(`npm pack created ${candidates.length} Worker tarballs`)
  const tarball = resolve(staging, candidates[0])
  if (!statSync(tarball).isFile() || statSync(tarball).size === 0) throw new Error('npm pack created an empty Worker tarball')

  execFileSync('tar', ['xzf', tarball, '-C', staging])
  const manifest = JSON.parse(readFileSync(join(workerRoot, 'package.json'), 'utf8'))
  const injected = new Set()
  const pending = [...(manifest.bundleDependencies ?? [])]
  while (pending.length > 0) {
    const name = pending.pop()
    if (injected.has(name)) continue
    injected.add(name)
    const short = name.slice('@wemux/'.length)
    const packageRoot = join(repositoryRoot, 'packages', short)
    const packageManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    if (!statSync(join(packageRoot, 'dist', 'index.js')).isFile()) throw new Error(`${name} dist is missing; run npm run build:packages first`)
    const target = join(staging, 'package', 'node_modules', '@wemux', short)
    cpSync(join(packageRoot, 'package.json'), join(target, 'package.json'))
    cpSync(join(packageRoot, 'dist'), join(target, 'dist'), { recursive: true })
    for (const dependency of Object.keys(packageManifest.dependencies ?? {})) {
      if (dependency.startsWith('@wemux/')) pending.push(dependency)
    }
  }
  execFileSync('tar', ['czf', tarball, '-C', staging, 'package'])
  return { tarball, bundled: [...injected].sort() }
}
