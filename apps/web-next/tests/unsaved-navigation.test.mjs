import test from 'node:test'
import assert from 'node:assert/strict'
import { registerUnsaved, confirmNavigation, hasUnsaved } from '../src/lib/unsaved-navigation.ts'
test('guards are in-memory, evaluate current dirtiness and retire without prompting', () => {
  let dirty = true, prompts = 0
  globalThis.window = { confirm: () => { prompts++; return false } }
  const dispose = registerUnsaved(() => dirty)
  assert.equal(hasUnsaved(), true); assert.equal(confirmNavigation(), false)
  dirty = false; assert.equal(confirmNavigation(), true); assert.equal(prompts, 1)
  dirty = true; dispose(); assert.equal(hasUnsaved(), false); assert.equal(prompts, 1)
  delete globalThis.window
})
test('creation and existing-content guards coexist and disposing one cannot bypass the other', () => {
  let creationDirty = true, contentDirty = true, prompts = 0
  globalThis.window = { confirm: () => { prompts++; return true } }
  const disposeCreation = registerUnsaved(() => creationDirty)
  const disposeContent = registerUnsaved(() => contentDirty)
  try {
    assert.equal(confirmNavigation(), true); assert.equal(prompts, 1)
    // Approval alone is not a reset: the departing component owns its retirement.
    assert.equal(hasUnsaved(), true)
    creationDirty = false
    assert.equal(hasUnsaved(), true)
    disposeCreation(); disposeCreation()
    assert.equal(confirmNavigation(), true); assert.equal(prompts, 2)
    contentDirty = false
    assert.equal(confirmNavigation(), true); assert.equal(prompts, 2)
    contentDirty = true; disposeContent()
    assert.equal(hasUnsaved(), false)
  } finally { disposeCreation(); disposeContent(); delete globalThis.window }
})
