import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'

const app = (await Promise.all(['App.tsx', 'features/sessions/conversation.tsx'].map(path => fs.readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')))).join('\n')
const reproPath = new URL('../../../scripts/e2e-message.mjs', import.meta.url)
const repro = await fs.readFile(reproPath, 'utf8').catch(() => null)

test('user message status uses minimal icon feedback instead of a text stepper', () => {
  assert.doesNotMatch(app, /\['已发送', '正在处理', '完成'\]/)
  assert.doesNotMatch(app, /正在处理这条消息。/)
  assert.doesNotMatch(app, /'回复完成'/)
  // 发送中 spinner、送达一枚淡勾、失败红字、助手侧三点打字动画
  assert.match(app, /aria-label="发送中"/)
  assert.match(app, /MessageStatus status=\{entry.status\}/)
  assert.match(app, /发送失败/)
  assert.match(app, /aria-label="正在回复"/)
  assert.match(app, /animate-bounce/)
  assert.doesNotMatch(app, /已受理/)
  assert.doesNotMatch(app, /消息已提交，等待工作节点确认/)
})

test('composer remains editable while a send acknowledgement is pending', () => {
  const composer = app.slice(app.indexOf('function Composer('))
  assert.doesNotMatch(composer, /<Textarea[^>]+disabled=\{pending\}/)
  assert.match(composer, /disabled=\{!canSend \|\| state\.pending \|\| !state\.draft\.trim\(\)\}/)
})

test('repository e2e script does not send timestamp markers to a persistent session', () => {
  if (repro === null) return
  assert.doesNotMatch(repro, /Date\.now\(\)|browser-repro|timeline-e2e|final-e2e|echo-check/)
})
