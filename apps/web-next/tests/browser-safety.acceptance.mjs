import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { browserConfiguration } from './acceptance-runtime.mjs'
try { browserConfiguration() } catch { console.error('Browser acceptance configuration required (details withheld).'); process.exit(1) }

for (const script of ['real-instance.mjs', 'real-legacy-regression.mjs']) test(`${script}: readonly password fill fails without credentials in stdout, stderr or result`, { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'next-private-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const server = createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<h1>登录控制台</h1><label>${script === 'real-instance.mjs' ? '邮箱或用户名' : '账号或邮箱'}<input></label><label>密码<input readonly></label>`))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const credentials = { login: 'PRIVATE-LOGIN-safety-fixture', password: 'PRIVATE-PASSWORD-safety-fixture' }
  const child = spawn(process.execPath, [new URL('./' + script, import.meta.url).pathname], { env: { ...process.env, WEMUX_NEXT_BASE_URL: `http://127.0.0.1:${server.address().port}`, WEMUX_NEXT_PROJECT_ID: 'fixture', WEMUX_NEXT_LOGIN_FILE: '', WEMUX_NEXT_LOGIN_STDIN: '1', WEMUX_NEXT_EVIDENCE: directory }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.end(JSON.stringify(credentials))
  const [code] = await once(child, 'exit')
  assert.notEqual(code, 0)
  const result = await readFile(join(directory, 'result.json'), 'utf8')
  for (const output of [stdout, stderr, result]) for (const secret of Object.values(credentials)) assert.equal(output.includes(secret), false, 'failure output must not contain credential values')
  assert.equal(JSON.parse(result).passed, false)
  assert.equal(JSON.parse(result).failure?.kind, 'acceptance-failed')
  assert.equal(JSON.parse(result).failure?.step, 'fill-password')
  assert.equal(stderr.trim(), 'Acceptance failed (details withheld).')
})
