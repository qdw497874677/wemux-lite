import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))

test('new Web is registered in root delivery without replacing the legacy Worker bundle', async () => {
  const root = await readJson('../../../package.json')
  const next = await readJson('../package.json')
  assert.equal(next.name, '@wemux/web-next')
  assert.equal(next.dependencies['@wemux/web-client'], '0.1.0')
  assert.equal(next.dependencies['@wemux/web-contract'], '0.1.0')
  assert.ok(!Object.hasOwn(next.dependencies, '@wemux/web'))
  assert.match(root.scripts.build, /--workspace @wemux\/web-next(?:\s|$)/)
  assert.match(root.scripts.test, /test:prepared --workspace @wemux\/web-next(?:\s|$)/)
  assert.match(root.scripts.build, /--workspace @wemux\/web(?:\s|$)/)
  assert.match(root.scripts.build, /pack:worker/)
  assert.equal(root.scripts.pretest, 'npm run build:test')
  assert.equal(root.scripts['build:test'], 'npm run build:packages && npm run build --workspace @wemux/server && npm run build --workspace @wemux/worker && npm run build --workspace @wemux/web')
  assert.doesNotMatch(root.scripts.test, /build:packages/)
  assert.equal(next.scripts['test:prepared'], 'node --experimental-strip-types --test tests/*.test.mjs src/components/__tests__/*.test.mjs')
  assert.equal(next.scripts['acceptance:safety'], 'node tests/browser-safety.acceptance.mjs')
  assert.equal(next.scripts.pretest, 'npm run build:packages --prefix ../.. && npm run build --workspace @wemux/server --prefix ../.. && npm run build --workspace @wemux/web --prefix ../..')
  const workerPack = await readFile(new URL('../../worker/scripts/build-worker-tarball.mjs', import.meta.url), 'utf8')
  assert.match(workerPack, /join\(repositoryRoot, 'apps', 'web', 'dist'\)/)
  assert.doesNotMatch(workerPack, /web-next/)
})

test('Vite resolves an independent /next/ production base and dist without API prefixing', async () => {
  const { resolveConfig } = await import('vite')
  const config = await resolveConfig({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)) }, 'build')
  assert.equal(config.base, '/next/')
  assert.equal(resolve(config.root, config.build.outDir), fileURLToPath(new URL('../dist', import.meta.url)))
  assert.equal(config.build.assetsDir, 'assets')
  assert.equal(config.publicDir, fileURLToPath(new URL('../public', import.meta.url)))
})

test('production favicon remains inside the next mount and is served as SVG', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-next-icon-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { build } = await import('vite')
  await build({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), build: { outDir: directory }, logLevel: 'silent' })
  const html = await readFile(join(directory, 'index.html'), 'utf8')
  assert.match(html, /rel="icon"[^>]+href="\/next\/favicon.svg"/)
  const svg = await readFile(join(directory, 'favicon.svg'), 'utf8')
  assert.match(svg, /<svg/)
  const { createWemuxServer } = await import('../../server/dist/server.js')
  const legacy = fileURLToPath(new URL('../../web/dist', import.meta.url))
  assert.match(await readFile(join(legacy, 'index.html'), 'utf8'), /rel="icon"[^>]+href="\/favicon.svg"/)
  const server = createWemuxServer({ databasePath: ':memory:', administratorEmails: ['fixture@example.test'], webStaticPath: legacy, webNextStaticPath: directory })
  const base = await server.listen(0)
  t.after(() => server.close())
  const response = await fetch(`${base}/next/favicon.svg`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /image\/svg\+xml/)
  assert.equal(await response.text(), svg)
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600')
  const oldIcon = await fetch(`${base}/favicon.svg`)
  assert.equal(oldIcon.status, 200)
  assert.match(oldIcon.headers.get('content-type'), /image\/svg\+xml/)
  assert.equal(oldIcon.headers.get('cache-control'), 'public, max-age=3600')
  assert.equal(await oldIcon.text(), await readFile(join(legacy, 'favicon.svg'), 'utf8'))
})

test('instance status reports effective bundle paths and marker drift without changing configuration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-delivery-status-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const release = join(directory, 'release')
  const legacy = join(release, 'apps/web/dist')
  const next = join(directory, 'explicit-next-dist')
  for (const root of [legacy, next]) {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'index.html'), '<title>fixture</title>')
  }
  const config = JSON.stringify({ release, node: process.execPath, workerHome: join(directory, 'worker'), url: 'http://127.0.0.1:0', serverEnvironment: { WEMUX_WEB_NEXT_DIST: next, PRIVATE_TEST_VALUE: 'must-not-print-this-value' } })
  await writeFile(join(directory, 'instance.json'), config)
  const marker = join(directory, 'previous-release') + '\n'
  await writeFile(join(directory, 'release-path'), marker)
  const result = spawnSync(process.execPath, [join(repositoryRoot, 'scripts/local-instance.mjs'), 'status'], { env: { ...process.env, WEMUX_INSTANCE_HOME: directory }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(`Root web: ${legacy} (ready)`))
  assert.ok(result.stdout.includes(`Next web (/next/): ${next} (ready)`))
  assert.match(result.stderr, /release-path differs from instance.json/)
  assert.ok(!`${result.stdout}${result.stderr}`.includes('must-not-print-this-value'))
  assert.equal(await readFile(join(directory, 'instance.json'), 'utf8'), config)
  assert.equal(await readFile(join(directory, 'release-path'), 'utf8'), marker)
})
