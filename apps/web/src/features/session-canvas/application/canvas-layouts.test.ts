import assert from 'node:assert/strict'
import test from 'node:test'
import { readPreferredCanvasLayout, saveCanvasLayout } from './canvas-layouts.ts'

const personal = { scope: 'personal' as const, graphRevision: 'g1', nodePositions: { s1: { x: 1, y: 2 } }, collapsedGroups: [], viewport: { x: 0, y: 0, zoom: 1 } }
const project = { ...personal, scope: 'project' as const }

test('personal layout wins before project default', async () => {
  const scopes: string[] = []
  const api = { canvasLayout: async (_projectId: string, scope: 'personal' | 'project') => { scopes.push(scope); return { graphRevision: 'g1', layout: scope === 'personal' ? personal : project } } }
  assert.deepEqual(await readPreferredCanvasLayout(api as never, 'project-1'), personal)
  assert.deepEqual(scopes, ['personal'])
})

test('project default is used when personal layout is absent', async () => {
  const scopes: string[] = []
  const api = { canvasLayout: async (_projectId: string, scope: 'personal' | 'project') => { scopes.push(scope); return { graphRevision: 'g1', layout: scope === 'personal' ? null : project } } }
  assert.deepEqual(await readPreferredCanvasLayout(api as never, 'project-1'), project)
  assert.deepEqual(scopes, ['personal', 'project'])
})

test('save emits a revision-bound layout without graph facts', async () => {
  let request: unknown
  const api = { saveCanvasLayout: async (_projectId: string, body: unknown) => { request = body; return { graphRevision: 'g1', written: true } } }
  await saveCanvasLayout(api as never, 'project-1', 'personal', 'g1', { s1: { x: 3, y: 4 } }, { x: 0, y: 0, zoom: 1 })
  assert.deepEqual(request, { scope: 'personal', graphRevision: 'g1', layout: { scope: 'personal', graphRevision: 'g1', nodePositions: { s1: { x: 3, y: 4 } }, collapsedGroups: [], viewport: { x: 0, y: 0, zoom: 1 } } })
  assert.equal(JSON.stringify(request).includes('edges'), false)
})
