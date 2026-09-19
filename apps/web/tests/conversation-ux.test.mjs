import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'

const app = (await Promise.all(['App.tsx', 'features/sessions/conversation.tsx', 'components/ui/ai-prompt-input.tsx'].map(path => fs.readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')))).join('\n')
const reproPath = new URL('../../../scripts/e2e-message.mjs', import.meta.url)
const repro = await fs.readFile(reproPath, 'utf8').catch(() => null)

test('user message status distinguishes queue, execution and terminal outcomes', () => {
  for (const label of ['', '', '', '', '']) assert.ok(app.includes(`${label}'`))
  assert.match(app, /MessageStatus status=\{entry.status\}/)
  assert.match(app, /animate-bounce/)
})

test('composer remains editable while a send acknowledgement is pending', () => {
  const composer = app.slice(app.indexOf('function Composer('))
  assert.doesNotMatch(composer, /<Textarea[^>]+disabled=\{pending\}/)
  assert.match(composer, /submitDisabled=\{!canSend \|\| state\.pending\}/)
  assert.match(app, /disabled=\{submitDisabled \|\| status === 'loading' \|\| !value\.trim\(\)\}/)
})

test('repository e2e script does not send timestamp markers to a persistent session', () => {
  if (repro === null) return
  assert.doesNotMatch(repro, /Date\.now\(\)|browser-repro|timeline-e2e|final-e2e|echo-check/)
})
