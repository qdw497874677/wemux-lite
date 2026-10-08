import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { withRealAppAbortEvidence } from './real-app-abort-evidence.mjs'

test('overlapping diagnostics own independent evidence under tmpdir and clean on success', async () => {
  let first, second
  const result = await withRealAppAbortEvidence(async evidence => {
    first = evidence
    assert.equal(dirname(evidence), tmpdir())
    await writeFile(join(first, 'result.json'), 'first')
    await withRealAppAbortEvidence(async evidence => {
      second = evidence
      assert.notEqual(first, second)
      assert.equal(dirname(second), tmpdir())
      await writeFile(join(second, 'result.json'), 'second')
      assert.equal(await readFile(join(first, 'result.json'), 'utf8'), 'first')
      assert.equal(await readFile(join(second, 'result.json'), 'utf8'), 'second')
    })
    await assert.rejects(stat(second), { code: 'ENOENT' })
    assert.equal(await readFile(join(first, 'result.json'), 'utf8'), 'first')
    return 'verified'
  })
  assert.equal(result, 'verified')
  await assert.rejects(stat(first), { code: 'ENOENT' })
})

test('failed diagnostic removes only owned evidence and retains original error', async () => {
  const neighbor = await mkdtemp(join(tmpdir(), 'wemux-real-app-abort-test-'))
  const error = new Error('fixture assertion failure')
  let owned
  try {
    await writeFile(join(neighbor, 'result.json'), 'unrelated')
    await assert.rejects(withRealAppAbortEvidence(async evidence => {
      owned = evidence
      await writeFile(join(owned, 'result.json'), 'failed')
      throw error
    }), caught => caught === error)
    await assert.rejects(stat(owned), { code: 'ENOENT' })
    assert.equal(await readFile(join(neighbor, 'result.json'), 'utf8'), 'unrelated')
  } finally { await rm(neighbor, { recursive: true, force: true }) }
})
