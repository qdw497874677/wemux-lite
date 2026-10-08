import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

test('Git snapshot enumeration includes nested artifact source but excludes root generated artifacts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wemux-gitignore-snapshot-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8' })
  git('init', '--quiet')
  await writeFile(join(root, '.gitignore'), await readFile(new URL('../../../.gitignore', import.meta.url)))
  const source = 'apps/web/src/features/artifacts/artifacts-section.tsx'
  for (const path of [source, 'artifacts/wemux-lite-worker.tgz', 'apps/web/dist/index.html']) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), 'fixture')
  }
  const files = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean)
  assert.ok(files.includes(source), 'nested artifacts source must survive Git-based snapshot selection')
  assert.ok(!files.includes('artifacts/wemux-lite-worker.tgz'))
  assert.ok(!files.includes('apps/web/dist/index.html'))
})
