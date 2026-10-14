// 路由与标签契约：四态与类别的每个取值都必须有中文标签，路由必须可解析到资源管理页。
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveRoute } from '../src/application.ts'
import { authenticationLabels, axisLabels, axisTitles, classLabels, configurationLabels, distributionLabels, executionLabels, observation } from '../src/lib/resource-labels.ts'

test('the resource management page has its own route and no legacy fallback', () => {
  assert.deepEqual(resolveRoute('/next/resources'), { kind: 'resources' })
  assert.equal(resolveRoute('/next/resources/unknown').kind, 'not-found')
})

test('every four-state value and resource class has a distinct Chinese label', () => {
  const sets = [configurationLabels, authenticationLabels, distributionLabels, executionLabels, classLabels]
  for (const record of sets) for (const [state, label] of Object.entries(record)) assert.ok(label.trim().length > 0, `${state} 缺少标签`)
  for (const record of sets) assert.equal(new Set(Object.values(record)).size, Object.keys(record).length, '同一轴内的状态标签不得重复')
  assert.deepEqual(Object.keys(axisTitles), [...axisLabels])
  // 四条轴的名字必须彼此不同：界面不得用同一个词表示两种状态。
  assert.equal(new Set(Object.values(axisTitles)).size, axisLabels.length)
})

test('an axis without probe evidence never reads as real time', () => {
  assert.equal(observation(null), '无探测证据')
  assert.match(observation('2026-05-01T00:00:00.000Z'), /^探测于 /)
})
