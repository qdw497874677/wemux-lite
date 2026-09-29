import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { prepareSkillRevision } from '../src/features/skills/skill-publish.ts'

const sha = value => createHash('sha256').update(value).digest('hex')
test('Skill Studio 发布 UTF-8 SKILL.md 的 hash、manifest 与 blob 一致', () => {
  const content = '# 测试技能\n使用中文说明。\n'
  const { revision, blobSha256, base64Content } = prepareSkillRevision({ resourceId: 'resource-1', revisionId: 'revision-1', version: 2, name: '技能', description: '描述', content, createdBy: 'actor', createdAt: '2026-01-01T00:00:00Z' })
  assert.equal(Buffer.from(base64Content, 'base64').toString('utf8'), content)
  assert.equal(blobSha256, sha(content))
  assert.equal(revision.payload.files[0].sha256, sha(content))
  assert.equal(revision.manifest.bytes, Buffer.byteLength(content))
  assert.equal(revision.contentSha256, revision.manifest.sha256)
  assert.equal(revision.supplyChain.manifestSha256, revision.manifest.sha256)
  assert.equal(revision.version, 2)
})
test('Skill Studio 不允许空内容和超过 1 MiB 的 UTF-8 内容', () => {
  const input = { resourceId: 'r', revisionId: 'v', version: 1, name: 'n', description: '', content: '', createdBy: 'a', createdAt: '2026-01-01T00:00:00Z' }
  assert.throws(() => prepareSkillRevision(input))
  assert.throws(() => prepareSkillRevision({ ...input, content: '中'.repeat(350000) }))
})
