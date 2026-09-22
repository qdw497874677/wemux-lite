import assert from 'node:assert/strict'
import test from 'node:test'
import { readCanvasViewState, writeCanvasViewState } from '../src/features/session-canvas/application/canvas-layout-store.ts'

class MemoryStorage {
  values = new Map()
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
  clear() { this.values.clear() }
  key(index) { return [...this.values.keys()][index] ?? null }
  get length() { return this.values.size }
}

test('canvas layout is restored only for the same project graph revision', () => {
  const storage = new MemoryStorage()
  const state = { graphRevision: 'revision-1', nodePositions: { 'session-1': { x: 10, y: 20 } }, viewport: { x: 2, y: 3, zoom: 0.8 } }
  writeCanvasViewState('project-1', state, storage)
  assert.deepEqual(readCanvasViewState('project-1', 'revision-1', storage), state)
  assert.equal(readCanvasViewState('project-1', 'revision-2', storage), null)
  assert.equal(readCanvasViewState('project-2', 'revision-1', storage), null)
})

test('malformed local layout never blocks the canvas', () => {
  const storage = new MemoryStorage()
  storage.setItem('wemux:session-canvas:project-1', '{bad-json')
  assert.equal(readCanvasViewState('project-1', 'revision-1', storage), null)
})
