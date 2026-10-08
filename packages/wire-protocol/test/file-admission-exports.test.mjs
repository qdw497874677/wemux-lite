import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Run after build:packages: verifies the public package surface, not source aliases.
test('built public Node subpath exposes cryptographic verification separately from root', async () => {
  const root = await import('@wemux/wire-protocol')
  const node = await import('@wemux/wire-protocol/file-admission-node')
  assert.equal(typeof root.serializeFileWriteFingerprint, 'function')
  assert.equal(typeof node.parseVerifiedServerFileWriteFrame, 'function')
  assert.equal(typeof node.parseVerifiedWorkerFileWriteFrame, 'function')
  assert.equal(typeof node.computeFileWriteFingerprint, 'function')
  assert.equal(root.computeFileWriteFingerprint, undefined)
  assert.equal(root.parseVerifiedServerFileWriteFrame, undefined)
})

test('built browser root has no transitive Node runtime imports or admission Node re-export', () => {
  const visited = new Set()
  const visit = (url) => {
    if (visited.has(url)) return
    visited.add(url)
    assert.equal(url.includes('file-admission-node'), false, url)
    const source = readFileSync(fileURLToPath(url), 'utf8')
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)]
    for (const [, specifier] of imports) {
      assert.equal(specifier.startsWith('node:'), false, `${url}: ${specifier}`)
      const child = specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier)
      visit(child)
    }
  }
  visit(import.meta.resolve('@wemux/wire-protocol'))
  assert.ok(visited.size > 5, `checked ${visited.size} modules`)
})
