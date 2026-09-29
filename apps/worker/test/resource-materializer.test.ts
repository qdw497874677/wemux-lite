import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ResourceBindingSnapshot } from '@wemux/domain'
import { ResourceStateStore } from '../src/resources/resource-state-store.ts'
import { SkillMaterializer } from '../src/resources/skill-materializer.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const binding = (revision: string, content: string): ResourceBindingSnapshot => ({
  bindingId: 'binding-1', bindingRevision: 1, agentKey: null, projectId: null, resourceId: 'skill-1', resourceRevisionId: revision,
  kind: 'skill', contentSha256: hash(`manifest-${revision}`),
  files: [{ path: 'SKILL.md', size: Buffer.byteLength(content), mediaType: 'text/markdown', sha256: hash(content), blobSha256: hash(content) }],
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'wemux-resource-materializer-'))
  const state = new ResourceStateStore(join(home, 'state.sqlite'))
  const materializer = new SkillMaterializer(home, state, () => '2026-01-01T00:00:00.000Z')
  return { home, state, materializer, close: async () => { state.close(); await rm(home, { recursive: true, force: true }) } }
}

test('SkillMaterializer 原子切换 current 并保留 previous', async () => {
  const f = await fixture()
  try {
    await f.materializer.materialize(binding('rev-1', '# one'), { fetch: async () => Buffer.from('# one') })
    await f.materializer.materialize(binding('rev-2', '# two'), { fetch: async () => Buffer.from('# two') })
    const root = join(f.home, 'resources', 'skill', 'skill-1')
    assert.equal(await readlink(join(root, 'current')), 'revisions/rev-2')
    assert.equal(await readlink(join(root, 'previous')), 'revisions/rev-1')
    assert.equal(await readFile(join(root, 'current', 'SKILL.md'), 'utf8'), '# two')
    assert.equal(await readFile(join(root, 'previous', 'SKILL.md'), 'utf8'), '# one')
    assert.equal(await f.materializer.resolveSkillPath('skill-1'), join(root, 'revisions', 'rev-2'))
  } finally { await f.close() }
})

test('拒绝跨资源目录 ID 和 revision 路径，保护 Worker home', async () => {
  const f = await fixture()
  try {
    const target = binding('revision-1', '# safe')
    await assert.rejects(f.materializer.materialize({ ...target, resourceId: '../outside' }, { fetch: async () => Buffer.from('# safe') }), /invalid_resource_path/)
    await assert.rejects(f.materializer.materialize({ ...target, resourceRevisionId: '../outside' }, { fetch: async () => Buffer.from('# safe') }), /invalid_resource_path/)
  } finally { await f.close() }
})

test('坏 hash 丢弃 staging 且不损坏 current', async () => {
  const f = await fixture()
  try {
    await f.materializer.materialize(binding('rev-1', '# good'), { fetch: async () => Buffer.from('# good') })
    await assert.rejects(() => f.materializer.materialize(binding('rev-2', '# expected'), { fetch: async () => Buffer.from('# corrupt') }), /hash_mismatch/)
    const root = join(f.home, 'resources', 'skill', 'skill-1')
    assert.equal(await readlink(join(root, 'current')), 'revisions/rev-1')
    assert.equal(await readFile(join(root, 'current', 'SKILL.md'), 'utf8'), '# good')
    await assert.rejects(() => stat(join(root, 'revisions', 'rev-2')))
  } finally { await f.close() }
})

test('LRU 不删除 current 和 previous，只清理超额旧 revision', async () => {
  const f = await fixture()
  try {
    for (const [revision, content] of [['rev-1', '# 1'], ['rev-2', '# 2'], ['rev-3', '# 3'], ['rev-4', '# 4']] as const) await f.materializer.materialize(binding(revision, content), { fetch: async () => Buffer.from(content) })
    const report = await f.materializer.collectGarbage('skill-1', { maxRetainedRevisions: 1 })
    const root = join(f.home, 'resources', 'skill', 'skill-1')
    assert.equal(await readlink(join(root, 'current')), 'revisions/rev-4')
    assert.equal(await readlink(join(root, 'previous')), 'revisions/rev-3')
    assert.equal(report.removed.length, 1)
    assert.equal(report.retained.length, 3)
    assert.equal(await readFile(join(root, 'current', 'SKILL.md'), 'utf8'), '# 4')
    assert.equal(await readFile(join(root, 'previous', 'SKILL.md'), 'utf8'), '# 3')
  } finally { await f.close() }
})
