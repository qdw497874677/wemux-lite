import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

test('files panel is registered as a keep-alive read-only panel', async () => {
  const app = await read('../src/App.tsx')
  assert.match(app, /id: 'files'.*icon: Files.*title: '文件'.*keepAlive: true/s)
  assert.match(app, /<FilesPanel api=\{api\} sessionId=\{selected\.id\}/)
})

test('files feature provides lazy tree, refresh, truncation, delimited and binary preview states', async () => {
  const panel = await read('../src/features/files/files-panel.tsx')
  const tree = await read('../src/features/files/file-tree.tsx')
  const preview = await read('../src/features/files/file-preview.tsx')
  assert.match(panel, /api\.listSessionFiles\(sessionId, path\)/)
  assert.match(panel, /aria-label="刷新文件"/)
  assert.match(tree, /state\.expanded\.has\(path\)/)
  assert.match(preview, /文件超过 1MB，仅显示前 1MB/)
  assert.match(preview, /不支持预览/)
  assert.match(preview, /DelimitedPreview/)
  assert.doesNotMatch(panel + tree + preview, /上传|下载|保存文件|编辑文件/)
})
