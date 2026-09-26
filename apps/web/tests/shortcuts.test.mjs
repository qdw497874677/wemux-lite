import assert from 'node:assert/strict'
import test from 'node:test'

import { createShortcutRegistry } from '../src/lib/shortcuts.ts'

const key = (value, init = {}) => ({ key: value, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, isComposing: false, preventDefault() { this.defaultPrevented = true }, ...init })

test('shortcut registry matches Cmd/Ctrl combos and ignores editable targets by default', () => {
  const registry = createShortcutRegistry()
  let focused = 0
  registry.register({ combo: 'Mod+K', scope: 'global', description: '搜索', handler: () => { focused++ } })
  assert.equal(registry.handle(key('k', { ctrlKey: true }), null), true)
  assert.equal(focused, 1)
  assert.equal(registry.handle(key('k', { metaKey: true }), { closest: () => ({}) }), false)
  assert.equal(focused, 1)
})

test('Escape closes only the highest registered active layer', () => {
  const registry = createShortcutRegistry()
  const closed = []
  registry.register({ combo: 'Escape', scope: 'dialog', description: '关闭对话框', priority: 100, handler: () => closed.push('dialog') })
  registry.register({ combo: 'Escape', scope: 'sheet', description: '关闭抽屉', priority: 200, handler: () => closed.push('sheet') })
  const removePanel = registry.register({ combo: 'Escape', scope: 'panel', description: '关闭面板', priority: 300, handler: () => closed.push('panel') })
  registry.handle(key('Escape'), null)
  removePanel()
  registry.handle(key('Escape'), null)
  assert.deepEqual(closed, ['panel', 'sheet'])
})

test('disabled registrations fall through and handlers may allow native behavior', () => {
  const registry = createShortcutRegistry()
  const events = []
  registry.register({ combo: 'Mod+B', scope: 'panel', description: '切换面板', priority: 2, enabled: () => false, handler: () => events.push('disabled') })
  registry.register({ combo: 'Mod+B', scope: 'global', description: '备用', handler: () => { events.push('fallback'); return false } })
  const event = key('b', { ctrlKey: true })
  assert.equal(registry.handle(event, null), true)
  assert.equal(event.defaultPrevented, false)
  assert.deepEqual(events, ['fallback'])
})
