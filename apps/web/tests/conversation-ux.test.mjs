import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'

const sources = Object.fromEntries(await Promise.all(['App.tsx', 'features/sessions/conversation.tsx', 'features/sessions/cluster-controls.tsx', 'components/ai-elements/prompt-input.tsx', 'components/context-window-meter.tsx'].map(async path => [path, await fs.readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')])))
const app = Object.values(sources).join('\n')
const reproPath = new URL('../../../scripts/e2e-message.mjs', import.meta.url)
const repro = await fs.readFile(reproPath, 'utf8').catch(() => null)

test('user message status distinguishes queue, execution and terminal outcomes', () => {
  for (const label of ['', '', '', '', '']) assert.ok(app.includes(`${label}'`))
  assert.match(app, /MessageStatus status=\{entry.status\}/)
  assert.match(app, /<Loader className="size-3\.5" \/>/)
})

test('composer remains editable while a send acknowledgement is pending', () => {
  const composer = app.slice(app.indexOf('function Composer('))
  assert.doesNotMatch(composer, /<Textarea[^>]+disabled=\{pending\}/)
  assert.match(composer, /!canSend \|\| state\.pending \|\| \(!state\.draft\.trim\(\) && !attachments\.files\.length\)/)
  assert.match(app, /const busy = status === 'submitted' \|\| status === 'streaming'/)
})

test('context usage is a circular composer tool and compact stays inside its popover', () => {
  const conversation = sources['features/sessions/conversation.tsx']
  const controls = sources['features/sessions/cluster-controls.tsx']
  const meter = sources['components/context-window-meter.tsx']
  assert.match(conversation, /name: '\/compact'/)
  assert.match(conversation, /正在压缩上下文…/)
  assert.match(conversation, /压缩失败，输入 \/compact 重试/)
  assert.match(conversation, /useCompactAction\(api, session\.id\)/)
  assert.match(conversation, /<span className="middle-truncate[^>]+>[^<]+<\/span><ContextWindowMeter/)
  assert.doesNotMatch(conversation, /conversation-content[^\n]+<ContextWindowMeter/)
  assert.match(meter, /<svg viewBox="0 0 24 24"/)
  assert.match(meter, /strokeDasharray=\{circumference\}/)
  assert.match(meter, /strokeDashoffset=\{dashOffset\}/)
  assert.match(meter, /percentage > 90 \? 'var\(--status-danger\)'/)
  assert.match(meter, /delay|setTimeout\(\(\) => setOpen\(true\), 150\)/)
  assert.match(meter, /<PopoverContent side="top" align="end"/)
  assert.match(meter, />压缩上下文<\/Button>/)
  assert.match(meter, /'上下文用量未知'/)
  assert.doesNotMatch(controls, />压缩上下文<|重试压缩上下文|feedback\('compact'\)/)
  assert.match(controls, /排队消息/)
  assert.match(controls, /待审批操作/)
})

test('repository e2e script does not send timestamp markers to a persistent session', () => {
  if (repro === null) return
  assert.doesNotMatch(repro, /Date\.now\(\)|browser-repro|timeline-e2e|final-e2e|echo-check/)
})
