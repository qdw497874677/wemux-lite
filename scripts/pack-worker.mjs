import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts')
mkdirSync(output, { recursive: true })
const staging = mkdtempSync(join(output, '.pack-'))
try {
  execFileSync('npm', ['pack', '--workspace', '@wemux/worker', '--pack-destination', staging], { cwd: root, stdio: 'inherit' })
  const candidates = readdirSync(staging).filter(entry => /^wemux-worker-.*\.tgz$/.test(entry))
  if (candidates.length !== 1) throw new Error(`npm pack created ${candidates.length} Worker tarballs`)
  const tarball = resolve(staging, candidates[0])
  if (!statSync(tarball).isFile() || statSync(tarball).size === 0) throw new Error('npm pack created an empty Worker tarball')
  renameSync(tarball, resolve(output, 'wemux-lite-worker.tgz'))
  console.log('Worker package ready: artifacts/wemux-lite-worker.tgz')
} finally {
  rmSync(staging, { recursive: true, force: true })
}
