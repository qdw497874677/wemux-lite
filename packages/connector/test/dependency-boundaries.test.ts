import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import test from 'node:test'

const sourceRoot = new URL('../src/', import.meta.url)

test('connector production source depends only on domain and Node/platform modules', async () => {
  for (const file of await sourceFiles(sourceRoot)) {
    const text = await readFile(file, 'utf8')
    assert.doesNotMatch(text, /(?:from|import\s*\()\s*['"][^'"]*(?:server-domain|web-contract|wire-protocol|apps\/)/u, file)
  }
})

test('production code never creates a default plaintext codec', async () => {
  for (const file of await sourceFiles(sourceRoot)) {
    const text = await readFile(file, 'utf8')
    assert.doesNotMatch(text, /new\s+PlaintextSecretCodec\s*\(/u, file)
    assert.doesNotMatch(text, /\?\s*new\s+AesGcmSecretCodec[^:]+:\s*new\s+PlaintextSecretCodec/u, file)
  }
})

async function sourceFiles(root: URL): Promise<string[]> {
  const directory = root.pathname
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name) === '.ts')
    .map((entry) => join(directory, entry.name))
}
