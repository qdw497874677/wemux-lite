import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'

const sources = Object.fromEntries(await Promise.all(['App.tsx', 'features/sessions/conversation.tsx', 'features/sessions/slash-commands.ts', 'features/sessions/cluster-controls.tsx', 'features/sessions/pending-approval-panel.tsx', 'components/ai-elements/prompt-input.tsx', 'components/context-window-meter.tsx'].map(async path => [path, await fs.readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')])))
const app = Object.values(sources).join('\n')
const reproPath = new URL('../../../scripts/e2e-message.mjs', import.meta.url)
const repro = await fs.readFile(reproPath, 'utf8').catch(() => null)

test('user message status distinguishes queue, execution and terminal outcomes', () => {
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
  assert.match(sources['features/sessions/slash-commands.ts'], /name: '\/compact'/)
  assert.match(conversation, /\/compact/)
  assert.match(conversation, /useCompactAction\(api, session\.id\)/)
  assert.match(conversation, /<SessionModelChip[^>]+\/><ContextWindowMeter/)
  assert.doesNotMatch(conversation, /conversation-content[^\n]+<ContextWindowMeter/)
  assert.match(meter, /<svg viewBox="0 0 24 24"/)
  assert.match(meter, /strokeDasharray=\{circumference\}/)
  assert.match(meter, /strokeDashoffset=\{dashOffset\}/)
  assert.match(meter, /percentage > 90 \? 'var\(--status-danger\)'/)
  assert.match(meter, /delay|setTimeout\(\(\) => setOpen\(true\), 150\)/)
  assert.match(meter, /<PopoverContent side="top" align="end"/)
  assert.doesNotMatch(controls, /feedback\('compact'\)/)
  assert.match(controls, /queuedItems\.length/)
})

test('pending approvals render above the composer with typed details and truthful decisions', () => {
  const appSource = sources['App.tsx']
  const panel = sources['features/sessions/pending-approval-panel.tsx']
  assert.ok(appSource.indexOf('<PendingApprovalPanel') < appSource.indexOf('<Composer api='))
  assert.match(panel, /pendingApprovals\.length/)
  assert.match(panel, /data-approval-kind=\{presentation\.kind\}/)
  assert.ok(panel.includes('aria-label=""'))
  assert.ok(panel.includes('aria-label=""'))
  assert.match(panel, /cwd: \{presentation\.cwd\}/)
  assert.ok(panel.includes(''))
  assert.ok(panel.includes(''))
  assert.doesNotMatch(panel, /JSON\.stringify/)
  assert.doesNotMatch(panel, /resolve\([^\n]+always|decision:\s*'always'/)
})

test('session model chip exposes supported models and preserves unsupported fallback', () => {
  const conversation = sources['features/sessions/conversation.tsx']
  assert.match(conversation, /agent\?\.modelSwap === true/)
  assert.match(conversation, /agent\.models\.map\(model =>/)
  assert.match(conversation, /name: 'set_model'/)
  assert.match(conversation, /setModelId\(previous\)/)
})

test('repository e2e script does not send timestamp markers to a persistent session', () => {
  if (repro === null) return
  assert.doesNotMatch(repro, /Date\.now\(\)|browser-repro|timeline-e2e|final-e2e|echo-check/)
})
