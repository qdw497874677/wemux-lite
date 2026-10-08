import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskContentDraft } from '../src/lib/task-content-draft.ts'
const content = { title: 'Original', description: 'first\nsecond\n', acceptanceCriteria: '- one\n- two', priority: 'none', metadataJson: { schemaVersion: 1, values: {} } }
test('only dirty fields are submitted; unrelated remote content merges without loss', () => {
  const draft = new TaskContentDraft(content)
  draft.edit('title', 'Local title')
  draft.receive({ ...content, description: 'Remote\nchange' })
  assert.equal(draft.values.description, 'Remote\nchange')
  assert.deepEqual(draft.submission().patch, { title: 'Local title' })
  assert.deepEqual(draft.conflicts, [])
})
test('reload retains dirty edits and same-field conflicts until explicit local or remote choice', () => {
  const draft = new TaskContentDraft(content)
  draft.edit('description', 'Local\ndraft')
  draft.receive({ ...content, description: 'Remote\nupdate', title: 'New title' })
  assert.equal(draft.values.description, 'Local\ndraft')
  assert.equal(draft.values.title, 'New title')
  assert.deepEqual(draft.conflicts, ['description'])
  draft.receive({ ...content, description: 'Remote\nupdate', title: 'New title' })
  assert.throws(() => draft.submission(), /冲突/)
  draft.resolve('description', 'local')
  assert.deepEqual(draft.submission().patch, { description: 'Local\ndraft' })
  draft.receive({ ...content, description: 'Another update' })
  draft.resolve('description', 'remote')
  assert.equal(draft.values.description, 'Another update')
  assert.deepEqual(draft.submission().patch, {})
})
test('multiline and null/empty values are preserved, not normalized by unrelated edits', () => {
  for (const acceptanceCriteria of [null, '', '\n  - yes\n- no\n']) {
    const draft = new TaskContentDraft({ ...content, acceptanceCriteria })
    draft.edit('title', 'Title only')
    assert.equal(draft.values.acceptanceCriteria, acceptanceCriteria)
    assert.equal(draft.values.description, content.description)
    assert.deepEqual(draft.submission().patch, { title: 'Title only' })
  }
  const draft = new TaskContentDraft({ ...content, acceptanceCriteria: null })
  draft.edit('acceptanceCriteria', '')
  assert.deepEqual(draft.submission().patch, { acceptanceCriteria: '' })
})
test('save acknowledges submitted snapshot only; identical remote result resolves conflict', () => {
  const draft = new TaskContentDraft(content)
  draft.edit('title', 'Submitted')
  const sent = draft.submission()
  draft.edit('title', 'Typed later')
  draft.saved(sent, { ...content, title: 'Submitted' })
  assert.equal(draft.values.title, 'Typed later')
  assert.deepEqual(draft.submission().patch, { title: 'Typed later' })
  draft.receive({ ...content, title: 'Typed later' })
  assert.deepEqual(draft.submission().patch, {})
})

test('metadata structural comparison ignores object order/format but preserves nested values and array order', () => {
  const metadataJson = { schemaVersion: 1, values: { a: null, nested: { b: [1, '', false], a: {} } } }
  const draft = new TaskContentDraft({ ...content, metadataJson })
  draft.edit('metadataJson', '{"values":{"nested":{"a":{},"b":[1,"",false]},"a":null},"schemaVersion":1}')
  assert.equal(draft.dirty, false)
  assert.deepEqual(draft.submission().patch, {})
  draft.edit('metadataJson', JSON.stringify({ ...metadataJson, values: { ...metadataJson.values, a: '' } }))
  assert.equal(draft.dirty, true)
  draft.receive({ ...content, metadataJson, description: 'Unrelated remote' })
  assert.equal(draft.values.description, 'Unrelated remote')
  assert.deepEqual(Object.keys(draft.submission().patch), ['metadataJson'])
})
test('metadata is one conflicting field, persists across reads, and requires explicit local/remote choice', () => {
  const draft = new TaskContentDraft(content)
  const local = '{"schemaVersion":1,"values":{"local":[null,{},""]}}'
  const remote = { schemaVersion: 1, values: { remote: true } }
  draft.edit('metadataJson', local)
  for (let i = 0; i < 2; i++) draft.receive({ ...content, metadataJson: remote })
  assert.equal(draft.values.metadataJson, local)
  assert.deepEqual(draft.conflicts, ['metadataJson'])
  assert.throws(() => draft.submission(), /冲突/)
  draft.resolve('metadataJson', 'local')
  const sent = draft.submission()
  assert.deepEqual(sent.patch, { metadataJson: JSON.parse(local) })
  draft.edit('metadataJson', '{invalid')
  draft.saved(sent, { ...content, metadataJson: JSON.parse(local) })
  assert.equal(draft.values.metadataJson, '{invalid')
  assert.throws(() => draft.submission(), SyntaxError)
  draft.receive({ ...content, metadataJson: remote })
  draft.resolve('metadataJson', 'remote')
  assert.deepEqual(JSON.parse(draft.values.metadataJson), remote)
  assert.equal(draft.dirty, false)
})
test('lost acknowledgement converges structurally, without re-sending accepted metadata', () => {
  const draft = new TaskContentDraft(content)
  const metadataJson = { schemaVersion: 1, values: { x: 1, y: 2 } }
  draft.edit('metadataJson', '{"values":{"y":2,"x":1},"schemaVersion":1}')
  draft.submission() // Response lost: saved is not called.
  draft.receive({ ...content, metadataJson })
  assert.equal(draft.dirty, false)
  assert.deepEqual(draft.submission().patch, {})
})
test('invalid metadata survives unrelated reads and validation failures verbatim; untouched metadata is not patched', () => {
  const metadataJson = { schemaVersion: 1, values: { nested: [null, '', {}], unknown: true } }
  const draft = new TaskContentDraft({ ...content, metadataJson })
  draft.edit('title', 'Title only')
  assert.deepEqual(draft.submission().patch, { title: 'Title only' })
  const invalid = '  {"schemaVersion":1,"values":null}\n'
  draft.edit('metadataJson', invalid)
  draft.receive({ ...content, metadataJson, description: 'Remote' })
  assert.equal(draft.values.metadataJson, invalid)
  assert.equal(draft.values.description, 'Remote')
  assert.throws(() => draft.submission(), /Expected an object/)
  assert.equal(draft.values.metadataJson, invalid)
  assert.equal(draft.dirty, true)
})
