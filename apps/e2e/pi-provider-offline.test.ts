import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { test } from 'node:test'
import type { ModelProviderResourceDefinition } from '@wemux/domain'
import { preparePiProviderDirectory } from '../worker/src/providers/pi-provider-directory.ts'

const executable = process.env.WEMUX_OFFLINE_PI_EXECUTABLE
const definition: ModelProviderResourceDefinition = {
  providerKey: 'openai-compatible', endpoint: 'https://example.invalid/v1', modelIds: ['offline-model'], agentKeys: ['pi' as never],
  credential: { kind: 'environment', variableNames: ['OPENAI_API_KEY'] },
}

test('real Pi lists the isolated compatible model in offline RPC without issuing a prompt', { skip: !executable }, async () => {
  assert.ok(executable)
  await access(executable)
  const prepared = await preparePiProviderDirectory(definition)
  const marker = 'offline-placeholder-not-a-real-secret'
  // This is deliberately a model-inventory probe, NOT an authentication probe.
  // Pi never receives a prompt and PI_OFFLINE forbids catalog refresh traffic.
  const child = spawn(executable, ['--mode', 'rpc', '--offline', '--no-approve', '--no-extensions', '--no-skills', '--model', prepared.modelId.replace('::', '/')], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PI_OFFLINE: '1', PI_CODING_AGENT_DIR: prepared.directory, OPENAI_API_KEY: marker },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const closed = new Promise<void>(resolve => { child.once('close', () => resolve()) })
  const result = new Promise<{ output: string; error: string }>((resolve, reject) => {
    let output = ''; let error = ''
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Pi offline inventory timed out')) }, 12_000)
    child.stdout.on('data', (part: Buffer) => {
      output += part.toString()
      for (const line of output.split('\n').filter(Boolean)) {
        try {
          const record = JSON.parse(line)
          if (record.id !== 'inventory' || record.type !== 'response') continue
          clearTimeout(timeout)
          child.kill('SIGTERM')
          resolve({ output: line, error })
          break
        } catch { /* incomplete JSON line */ }
      }
    })
    child.stderr.on('data', (part: Buffer) => { error = (error + part).slice(-2000) })
    child.once('error', cause => { clearTimeout(timeout); reject(cause) })
    child.once('close', () => { clearTimeout(timeout); reject(new Error(`Pi exited before responding: ${error}`)) })
  })
  try {
    child.stdin.write(JSON.stringify({ type: 'get_available_models', id: 'inventory' }) + '\n')
    const { output, error } = await result
    const parsed = JSON.parse(output) as { success: boolean; data?: { models?: Array<{ provider: string; id: string; baseUrl: string }> } }
    assert.equal(parsed.success, true, error)
    assert.deepEqual(parsed.data?.models?.filter(model => model.provider === 'openai-compatible' && model.id === 'offline-model').map(model => model.baseUrl), [definition.endpoint])
    assert.doesNotMatch(output + error, new RegExp(marker))
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1000))])
    await prepared.cleanup()
  }
})
