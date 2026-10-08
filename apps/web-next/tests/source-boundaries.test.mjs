// Supplemental source contracts; application and browser tests prove behavior.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = resolve(new URL('../src', import.meta.url).pathname)
async function sources(dir) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await sources(path))
    else if (/\.(tsx?|css)$/.test(entry.name)) files.push(path)
  }
  return files
}
test('new UI stays independent of legacy pages and HTTP-unsafe browser APIs', async () => {
  for (const file of await sources(root)) {
    const text = await readFile(file, 'utf8')
    assert.doesNotMatch(text, /(?:from|import)\s*[(]?['"][^'"]*(?:apps\/web\/|\.\.\/web\/)/, file)
    assert.doesNotMatch(text, /crypto\.randomUUID\s*\(|execCommand\s*\(/, file)
    for (const match of text.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) assert.match(match[1], /\.(?:ts|tsx|css|txt\?raw)$/, `${file}: ${match[1]}`)
  }
})
test('complete Paperclip MIT notice is retained in the shipped UI dependency graph', async () => {
  const notice = await readFile(join(root, 'PAPERCLIP-LICENSE.txt'), 'utf8')
  assert.match(notice, /Copyright \(c\) 2025 Paperclip AI/)
  assert.match(notice, /Permission is hereby granted/)
  assert.match(notice, /THE SOFTWARE IS PROVIDED "AS IS"/)
  assert.match(await readFile(join(root, 'components/PaperclipNotice.tsx'), 'utf8'), /PAPERCLIP-LICENSE\.txt\?raw/)
})
