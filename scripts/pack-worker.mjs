import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildWorkerTarball } from '../apps/worker/scripts/build-worker-tarball.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'artifacts')
mkdirSync(output, { recursive: true })
const staging = join(output, '.pack-worker-staging')
try {
  mkdirSync(staging, { recursive: true })
  const { tarball, bundled } = buildWorkerTarball({ repositoryRoot: root, packDestination: staging })
  const final = resolve(output, 'wemux-lite-worker.tgz')
  renameSync(tarball, final)
  console.log(`Worker package ready: artifacts/wemux-lite-worker.tgz (bundled: ${bundled.join(', ')})`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
