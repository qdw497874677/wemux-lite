import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelProviderResourceDefinition } from '@wemux/domain'
import { preparePiProviderDirectory } from '../src/providers/pi-provider-directory.ts'

const definition: ModelProviderResourceDefinition = {
  providerKey: 'openai-compatible', endpoint: 'https://example.invalid/v1', modelIds: ['offline-model'], agentKeys: ['pi' as never],
  credential: { kind: 'worker-credential', credentialRef: 'local-ref', variableNames: ['OPENAI_API_KEY'] },
}

async function absent(path: string) { await assert.rejects(access(path), { code: 'ENOENT' }) }

// No real credentials or paid requests. Pi only answers get_available_models from its own local inventory.
test('Pi isolated model directory contains no secret and never reads a saved user auth directory', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wemux-provider-dir-test-'))
  const user = join(base, 'user')
  const sentinel = 'sentinel-model-secret-never-write-8371'
  await (await import('node:fs/promises')).mkdir(user)
  await writeFile(join(user, 'auth.json'), JSON.stringify({ 'openai-compatible': { type: 'api_key', key: 'unrelated-saved-key' } }))
  let prepared: Awaited<ReturnType<typeof preparePiProviderDirectory>> | undefined
  try {
    prepared = await preparePiProviderDirectory(definition, base)
    assert.equal((await stat(prepared.directory)).mode & 0o777, 0o700)
    assert.equal((await stat(join(prepared.directory, 'models.json'))).mode & 0o777, 0o600)
    assert.equal(prepared.modelId, 'openai-compatible::offline-model')
    const models = JSON.parse(await readFile(join(prepared.directory, 'models.json'), 'utf8'))
    assert.deepEqual(models, { providers: { 'openai-compatible': { baseUrl: definition.endpoint, api: 'openai-completions', apiKey: '$OPENAI_API_KEY', models: [{ id: 'offline-model' }] } } })
    assert.doesNotMatch(JSON.stringify(models), /sentinel-model-secret|unrelated-saved-key|!command/)
    await absent(join(prepared.directory, 'auth.json'))
    await absent(join(prepared.directory, 'extensions'))
    const fake = join(base, 'fake-pi')
    await writeFile(fake, `#!${process.execPath}\nconst fs=require('node:fs'); const dir=process.env.PI_CODING_AGENT_DIR; process.stdout.write(JSON.stringify({models:JSON.parse(fs.readFileSync(dir+'/models.json')),authPresent:fs.existsSync(dir+'/auth.json'),key:process.env.OPENAI_API_KEY}));\n`, { mode: 0o700 })
    await chmod(fake, 0o700)
    const received = await new Promise<string>((resolve, reject) => {
      const child = spawn(fake, [], { env: { ...process.env, PI_CODING_AGENT_DIR: prepared!.directory, OPENAI_API_KEY: sentinel }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', chunk => { output += chunk })
      child.once('error', reject).once('close', code => code === 0 ? resolve(output) : reject(new Error(`fake pi exited ${code}`)))
    })
    assert.equal(JSON.parse(received).authPresent, false)
    assert.equal(JSON.parse(received).key, sentinel, 'Secret is passed only via child environment')
    assert.doesNotMatch(await readFile(join(prepared.directory, 'models.json'), 'utf8'), /sentinel-model-secret/)
    await prepared.cleanup()
    await prepared.cleanup()
    await absent(prepared.directory)
    assert.match(await readFile(join(user, 'auth.json'), 'utf8'), /unrelated-saved-key/)
  } finally { await prepared?.cleanup(); await rm(base, { recursive: true, force: true }) }
})

test('Pi directory refuses incomplete or unsafe model definitions before writing anything', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wemux-provider-dir-bad-'))
  try {
    for (const bad of [
      { ...definition, providerKey: 'anthropic' },
      { ...definition, credential: { ...definition.credential, variableNames: ['FIRST_KEY', 'SECOND_KEY'] } },
      { ...definition, modelIds: ['first', 'second'] },
      { ...definition, endpoint: 'https://user:secret@example.invalid/v1' },
      { ...definition, agentKeys: ['claude-code'] },
    ]) await assert.rejects(preparePiProviderDirectory(bad as ModelProviderResourceDefinition, base), /pi_provider_configuration_unsupported|invalid_provider/)
    assert.deepEqual((await (await import('node:fs/promises')).readdir(base)), [])
  } finally { await rm(base, { recursive: true, force: true }) }
})
