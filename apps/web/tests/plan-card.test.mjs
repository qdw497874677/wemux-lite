import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import { build } from 'esbuild'
import { chromium } from '/opt/data/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs'

import { parseProposedPlanSteps, projectJournal } from '../src/api/journal.ts'

const event = (seq, payload) => ({ seq, sessionId: 'session-1', occurredAt: `2026-03-01T00:00:0${seq}.000Z`, payload })

test('plan_text deltas aggregate into one completed proposed plan at the end of the turn', () => {
  const journal = projectJournal([
    event(1, { kind: 'assistant.text.delta', turnId: 'turn-1', text: '1. Inspect files\n', streamKind: 'plan_text' }),
    event(2, { kind: 'assistant.text.delta', turnId: 'turn-1', text: '2. Add tests', streamKind: 'plan_text' }),
    event(3, { kind: 'turn.finished', turnId: 'turn-1', outcome: 'completed', failure: null }),
  ])
  assert.deepEqual(journal.timeline, [{ kind: 'plan', id: 'plan:turn-1', turnId: 'turn-1', text: '1. Inspect files\n2. Add tests', steps: ['Inspect files', 'Add tests'], status: 'pending' }])
})

test('incomplete and failed plan streams do not claim a complete proposed plan', () => {
  assert.equal(projectJournal([event(1, { kind: 'assistant.text.delta', turnId: 'turn-1', text: 'draft', streamKind: 'plan_text' })]).timeline.length, 0)
  assert.equal(projectJournal([
    event(1, { kind: 'assistant.text.delta', turnId: 'turn-1', text: 'draft', streamKind: 'plan_text' }),
    event(2, { kind: 'turn.finished', turnId: 'turn-1', outcome: 'failed', failure: null }),
  ]).timeline.some(item => item.kind === 'plan'), false)
})

test('step parser accepts numbered and checkbox lists and honestly falls back for prose', () => {
  assert.deepEqual(parseProposedPlanSteps('1) First\n2. Second'), ['First', 'Second'])
  assert.deepEqual(parseProposedPlanSteps('- [ ] Draft\n* [x] Verify'), ['Draft', 'Verify'])
  assert.equal(parseProposedPlanSteps('First inspect the repository, then make the change.'), undefined)
})

test('a later user message resolves pending plans into approved or modified history', () => {
  const base = [
    event(1, { kind: 'assistant.text.delta', turnId: 'turn-1', text: 'Plan', streamKind: 'plan_text' }),
    event(2, { kind: 'turn.finished', turnId: 'turn-1', outcome: 'completed', failure: null }),
  ]
  const approved = projectJournal([...base, event(3, { kind: 'message.queued', commandId: 'c1', messageId: 'm1', content: '批准执行上述计划', position: 1 })])
  assert.equal(approved.timeline.find(item => item.kind === 'plan')?.status, 'approved')
  const modified = projectJournal([...base, event(3, { kind: 'message.queued', commandId: 'c1', messageId: 'm1', content: 'Please revise step 2', position: 1 })])
  assert.equal(modified.timeline.find(item => item.kind === 'plan')?.status, 'modified')
})

test('rendered plan card supports structured steps, markdown fallback, actions and collapse', async () => {
  const bundle = await build({ entryPoints: [new URL('./plan-card-rendered.tsx', import.meta.url).pathname], bundle: true, write: false, format: 'iife', jsx: 'automatic' })
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/test.js' ? 'text/javascript' : 'text/html')
    response.end(request.url === '/test.js' ? bundle.outputFiles[0].text : '<div id="root"></div><script src="/test.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ headless: true, executablePath: '/opt/data/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const cards = page.getByRole('article', { name: '执行计划' })
    assert.equal(await cards.count(), 2)
    assert.equal(await cards.nth(0).getByText('Inspect files').count(), 1)
    assert.equal(await cards.nth(1).getByText('Keep the full Markdown plan.').count(), 1)
    await cards.nth(0).getByRole('button', { name: '批准' }).click()
    await page.getByTestId('result').getByText('approved').waitFor()
    await cards.nth(0).getByRole('button', { name: '修改' }).click()
    await page.getByTestId('result').getByText('modified:1. Inspect files').waitFor()
    await cards.nth(0).getByRole('button', { name: '折叠' }).click()
    assert.equal(await cards.nth(0).getByText('Inspect files').count(), 0)
    assert.equal(await cards.nth(0).getByRole('button', { name: '展开' }).count(), 1)
  } finally {
    await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
})

test('session integration sends approval verbatim and pre-fills modifications as new messages', async () => {
  const card = await readFile(new URL('../src/features/sessions/plan-card.tsx', import.meta.url), 'utf8')
  const surface = await readFile(new URL('../src/features/sessions/session-surface.tsx', import.meta.url), 'utf8')
  assert.match(card, /执行计划/)
  assert.match(card, /待确认/)
  assert.match(card, /plan\.steps\?\.length/)
  assert.match(card, /<Response>\{plan\.text\}<\/Response>/)
  assert.match(card, /setCollapsed/)
  assert.match(card, /onClick=\{onApprove\}/)
  assert.match(card, /onClick=\{onModify\}/)
  assert.match(surface, /controller\.resendAsNew\('批准执行上述计划'\)/)
  assert.match(surface, /controller\.prefillForEdit\(text\)/)
})
