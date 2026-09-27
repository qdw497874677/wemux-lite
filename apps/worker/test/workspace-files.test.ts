import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { listWorkspaceFiles, MAX_FILE_READ_BYTES, readWorkspaceFile } from '../src/files/workspace-files.js'

const fixture = async () => {
  const parent = await mkdtemp(join(tmpdir(), 'wemux-files-'))
  const root = join(parent, 'workspace')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'README.md'), 'hello\n')
  await writeFile(join(root, 'src', 'index.ts'), 'export {}\n')
  return { parent, root }
}

test('workspace file access rejects traversal and symlink escape', async () => {
  const { parent, root } = await fixture()
  try {
    await writeFile(join(parent, 'secret.txt'), 'secret')
    await symlink(join(parent, 'secret.txt'), join(root, 'escape'))
    await assert.rejects(readWorkspaceFile(root, '../secret.txt', 100), /escapes workspace root/)
    await assert.rejects(readWorkspaceFile(root, 'escape', 100), /escapes workspace root/)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('workspace file read truncates at the requested limit and caps requests at 1MB', async () => {
  const { parent, root } = await fixture()
  try {
    await writeFile(join(root, 'large.txt'), 'x'.repeat(MAX_FILE_READ_BYTES + 32))
    assert.deepEqual(await readWorkspaceFile(root, 'large.txt', 16), {
      content: 'x'.repeat(16),
      size: MAX_FILE_READ_BYTES + 32,
      truncated: true,
      binary: false,
    })
    await assert.rejects(readWorkspaceFile(root, 'large.txt', MAX_FILE_READ_BYTES + 1), /maxBytes/)
    await writeFile(join(root, 'binary.dat'), Buffer.from([0xff, 0xfe, 0xfd]))
    assert.deepEqual(await readWorkspaceFile(root, 'binary.dat', 16), { content: null, size: 3, truncated: false, binary: true })
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('workspace directory listing returns sorted files and directories with metadata', async () => {
  const { parent, root } = await fixture()
  try {
    const entries = await listWorkspaceFiles(root, '')
    assert.deepEqual(entries.map(({ name, type, size }) => ({ name, type, size })), [
      { name: 'src', type: 'directory', size: entries[0]?.size },
      { name: 'README.md', type: 'file', size: 6 },
    ])
    assert.match(entries[0]?.mtime ?? '', /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})
