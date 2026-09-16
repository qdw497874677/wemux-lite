import test from 'node:test'
import assert from 'node:assert/strict'
import { negotiateRuntimeCompatibility } from '@wemux/domain'

test('runtime protocol negotiation fails closed for unsupported versions and missing features', () => {
  assert.deepEqual(negotiateRuntimeCompatibility([2], ['tools', 'usage'], 2, ['usage']), { compatible: true, protocolVersion: 2, missingFeatures: [] })
  assert.deepEqual(negotiateRuntimeCompatibility([1], ['usage'], 2), { compatible: false, missingFeatures: [], reason: 'unsupported_protocol' })
  assert.deepEqual(negotiateRuntimeCompatibility([2], ['tools'], 2, ['usage']), { compatible: false, protocolVersion: 2, missingFeatures: ['usage'], reason: 'missing_feature' })
})
