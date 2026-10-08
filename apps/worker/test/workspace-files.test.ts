import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { diffWorkspaceFile, FILE_READ_ERROR, fileReadErrorMessage, listWorkspaceFiles, MAX_FILE_READ_BYTES, MAX_FILE_WRITE_BYTES, parseGitDiff, readWorkspaceFile, writeWorkspaceFile } from '../src/files/workspace-files.js'

const git = promisify(execFile)

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

test('workspace file write is binary-safe, creates parents, and rejects traversal, symlink escapes, invalid base64, and oversized content', async () => {
  const { parent, root } = await fixture()
  try {
    const binary = Buffer.from([0, 1, 2, 0xfe, 0xff])
    assert.deepEqual(await writeWorkspaceFile(root, 'uploads/nested/image.bin', binary.toString('base64')), { subpath: 'uploads/nested/image.bin', size: binary.length })
    assert.deepEqual(await readWorkspaceFile(root, 'uploads/nested/image.bin', 32), { content: null, base64Content: binary.toString('base64'), size: binary.length, truncated: false, binary: true })
    await writeFile(join(parent, 'secret.txt'), 'secret')
    await symlink(parent, join(root, 'escape-dir'))
    await assert.rejects(writeWorkspaceFile(root, '../secret.txt', 'YQ=='), /escapes workspace root/)
    await assert.rejects(writeWorkspaceFile(root, 'escape-dir/file.txt', 'YQ=='), /escapes workspace root/)
    await assert.rejects(writeWorkspaceFile(root, 'uploads/bad.bin', '%%%'), /Invalid base64 content/)
    await assert.rejects(writeWorkspaceFile(root, 'uploads/large.bin', Buffer.alloc(MAX_FILE_WRITE_BYTES + 1).toString('base64')), /byte limit/)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('workspace file read truncates at the requested limit and caps requests at 10MB', async () => {
  const { parent, root } = await fixture()
  try {
    assert.equal(MAX_FILE_READ_BYTES, 10 * 1024 * 1024)
    await writeFile(join(root, 'large.txt'), 'x'.repeat(MAX_FILE_READ_BYTES))
    assert.deepEqual(await readWorkspaceFile(root, 'large.txt', 16), {
      content: 'x'.repeat(16),
      size: MAX_FILE_READ_BYTES,
      truncated: true,
      binary: false,
    })
    await assert.rejects(readWorkspaceFile(root, 'large.txt', MAX_FILE_READ_BYTES + 1), /maxBytes/)
    await writeFile(join(root, 'large.txt'), Buffer.alloc(MAX_FILE_READ_BYTES + 1, 0x78))
    await assert.rejects(readWorkspaceFile(root, 'large.txt', MAX_FILE_READ_BYTES), { message: `${FILE_READ_ERROR.tooLarge}: File exceeds ${MAX_FILE_READ_BYTES} byte limit` })
    await writeFile(join(root, 'binary.dat'), Buffer.from([0xff, 0xfe, 0xfd]))
    assert.deepEqual(await readWorkspaceFile(root, 'binary.dat', 16), { content: null, base64Content: '//79', size: 3, truncated: false, binary: true })
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('git diff parser returns structured additions, deletions and context line numbers', () => {
  assert.deepEqual(parseGitDiff('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+second\n three\n'), [
    { type: 'ctx', oldLine: 1, newLine: 1, text: 'one' },
    { type: 'del', oldLine: 2, text: 'two' },
    { type: 'add', newLine: 2, text: 'second' },
    { type: 'ctx', oldLine: 3, newLine: 3, text: 'three' },
  ])
})

test('workspace diff compares staged and unstaged changes with HEAD and preserves path safety', async () => {
  const { parent, root } = await fixture()
  try {
    await git('git', ['init'], { cwd: root })
    await git('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
    await git('git', ['config', 'user.name', 'Test'], { cwd: root })
    await git('git', ['add', '.'], { cwd: root })
    await git('git', ['commit', '-m', 'initial'], { cwd: root })
    await writeFile(join(root, 'README.md'), 'hello world\n')
    await git('git', ['add', 'README.md'], { cwd: root })
    await writeFile(join(root, 'README.md'), 'hello worker\n')
    await writeFile(join(parent, 'secret.txt'), 'secret\n')
    assert.deepEqual(await diffWorkspaceFile(root, 'README.md'), {
      supported: true,
      lines: [
        { type: 'del', oldLine: 1, text: 'hello' },
        { type: 'add', newLine: 1, text: 'hello worker' },
      ],
    })
    await writeFile(join(root, 'untracked.txt'), 'new file\n')
    assert.deepEqual(await diffWorkspaceFile(root, 'untracked.txt'), { supported: true, lines: [{ type: 'add', newLine: 1, text: 'new file' }] })
    await rm(join(root, 'README.md'))
    assert.deepEqual(await diffWorkspaceFile(root, 'README.md'), { supported: true, lines: [{ type: 'del', oldLine: 1, text: 'hello' }] })
    await assert.rejects(diffWorkspaceFile(root, '../secret.txt'), /escapes workspace root/)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('workspace diff honestly reports non-git files as unsupported', async () => {
  const { parent, root } = await fixture()
  try {
    assert.deepEqual(await diffWorkspaceFile(root, 'README.md'), { supported: false, reason: 'not-git', lines: [] })
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

test('workspace read preserves UTF-8 BOM, empty files and binary NUL bytes', async () => {
  const { parent, root } = await fixture()
  try {
    for (const bytes of [Buffer.from('\ufeff成果\r\n'), Buffer.alloc(0), Buffer.from([0, 1, 255, 0])]) {
      await writeFile(join(root, 'result'), bytes)
      const result = await readWorkspaceFile(root, 'result', MAX_FILE_READ_BYTES)
      assert.equal(result.truncated, false)
      assert.equal(result.size, bytes.length)
      assert.deepEqual(result.binary ? Buffer.from(result.base64Content!, 'base64') : Buffer.from(result.content!, 'utf8'), bytes)
      if (!result.binary) assert.equal(result.base64Content, undefined)
    }
  } finally { await rm(parent, { recursive: true, force: true }) }
})

test('workspace read error classification does not forward paths or file fragments', () => {
  for (const code of ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO']) {
    const message = fileReadErrorMessage(Object.assign(new Error('/secret/path: private bytes'), { code }))
    assert.match(message, code === 'ENOENT' || code === 'ENOTDIR' ? /^file_not_found:/ : /^file_unreadable:/)
    assert.doesNotMatch(message, /secret|private/)
  }
  assert.equal(fileReadErrorMessage(new Error(`${FILE_READ_ERROR.accessRevoked}: revoked`)), 'file_access_revoked: revoked')
})
