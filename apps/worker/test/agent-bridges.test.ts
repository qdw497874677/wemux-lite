import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import type { ModelId } from '@wemux/domain'
import { ClaudeAgent } from '../src/agents/claude-agent.js'
import { PiAgent } from '../src/agents/pi-agent.js'
import { modelId } from '@wemux/domain'

async function fixtureScript(body: string) {
  const home = await mkdtemp(join(tmpdir(), 'wemux-lite-agent-'))
  const path = join(home, 'agent-fixture')
  await writeFile(path, `#!/usr/bin/env node\n${body}`, 'utf8')
  await chmod(path, 0o755)
  return { home, path, close: () => rm(home, { recursive: true, force: true }) }
}

async function collect(handle: Awaited<ReturnType<ClaudeAgent['startTurn']>>) {
  const signals = []
  for await (const signal of handle.signals) signals.push(signal)
  return signals
}

const input = (cwd: string, resume: string | null = null) => ({ sessionId: 'session' as any, turnId: 'turn' as any, cwd, modelId: 'sonnet' as ModelId, message: { messageId: 'message' as any, content: 'hello' }, resume: resume as any, launchContext: null })

test('Claude bridge detects, streams JSONL, binds native session and maps tools', async () => {
  const fixture = await fixtureScript(`
if (process.argv.includes('--version')) { console.log('claude fixture 1.0'); process.exit(0) }
process.stdin.resume(); process.stdin.on('end', () => {
 console.log(JSON.stringify({type:'stream_event',session_id:'native-1',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Hi'}}}))
 console.log(JSON.stringify({type:'stream_event',session_id:'native-1',event:{type:'content_block_start',index:1,content_block:{type:'tool_use',id:'tool-1',name:'Read',input:{}}}}))
 console.log(JSON.stringify({type:'stream_event',session_id:'native-1',event:{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"path":'}}}))
 console.log(JSON.stringify({type:'stream_event',session_id:'native-1',event:{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'"x"}'}}}))
 console.log(JSON.stringify({type:'stream_event',session_id:'native-1',event:{type:'content_block_stop',index:1}}))
 console.log(JSON.stringify({type:'user',session_id:'native-1',message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'done'}]}}))
 console.log(JSON.stringify({type:'result',session_id:'native-1'}))
})`)
  try {
    const agent = new ClaudeAgent(fixture.path)
    assert.equal((await agent.detect()).availability.status, 'available')
    const signals = await collect(await agent.startTurn(input(fixture.home)))
    assert(signals.some(signal => signal.kind === 'native-session' && signal.nativeSession === 'native-1'))
    assert(signals.some(signal => signal.kind === 'event' && signal.event.kind === 'assistant.text.delta' && signal.event.text === 'Hi'))
    assert(signals.some(signal => signal.kind === 'event' && signal.event.kind === 'tool.started' && (signal.event.input as any).path === 'x'))
    assert(signals.some(signal => signal.kind === 'event' && signal.event.kind === 'tool.finished'))
    assert.deepEqual(signals.at(-1), { kind: 'finished', outcome: { status: 'completed' } })
  } finally { await fixture.close() }
})

test('Claude bridge rejects a truncated protocol even when a session id was emitted', async () => {
  const fixture = await fixtureScript(`
if (process.argv.includes('--version')) { console.log('v'); process.exit(0) }
process.stdin.resume(); process.stdin.on('end', () => { console.log(JSON.stringify({type:'system',session_id:'native-only'})) })
`)
  try {
    const signals = await collect(await new ClaudeAgent(fixture.path).startTurn(input(fixture.home)))
    assert.equal((signals.at(-1) as any).outcome.failure.code, 'agent-error')
  } finally { await fixture.close() }
})

test('Claude bridge forwards resume/model flags and stop cancels the process', async () => {
  const fixture = await fixtureScript(`
if (process.argv.includes('--version')) { console.log('v'); process.exit(0) }
if (!process.argv.includes('--resume') || !process.argv.includes('old-native') || !process.argv.includes('--model')) process.exit(9)
process.stdin.resume(); setInterval(() => {}, 1000)
`)
  try {
    const agent = new ClaudeAgent(fixture.path)
    const handle = await agent.startTurn(input(fixture.home, 'old-native'))
    await new Promise(resolve => setTimeout(resolve, 25))
    await handle.stop()
    assert.deepEqual((await collect(handle)).at(-1), { kind: 'finished', outcome: { status: 'cancelled' } })
  } finally { await fixture.close() }
})

test('Pi bridge completes a real prompt with an authenticated configured model when available', { timeout: 60_000 }, async t => {
  if (process.env.WEMUX_REAL_AGENT_SMOKE !== '1') { t.skip('set WEMUX_REAL_AGENT_SMOKE=1 to run paid/network smoke'); return }
  const detected = await new PiAgent().detect()
  if (detected.availability.status !== 'available' || !detected.models.length) { t.skip('no authenticated Pi model available'); return }
  const cwd = await mkdtemp(join(tmpdir(), 'wemux-lite-pi-smoke-'))
  try {
    const handle = await new PiAgent().startTurn({ ...input(cwd), modelId: detected.models[0]!.modelId })
    const signals = []
    for await (const signal of handle.signals) signals.push(signal)
    assert(signals.some(signal => signal.kind === 'native-session'))
    assert.deepEqual(signals.at(-1), { kind: 'finished', outcome: { status: 'completed' } })
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('Pi bridge rejects ambiguous unqualified model ids', async () => {
  await assert.rejects(() => new PiAgent().startTurn({ ...input(process.cwd()), modelId: 'gpt-5.4' as ModelId }), /ambiguous/)
})

test('Pi bridge detects authenticated configured models', async () => {
  const detected = await new PiAgent().detect()
  assert.equal(detected.mode, 'execution')
  assert.equal(detected.agentKey, 'pi')
  if (detected.availability.status === 'available') {
    assert(detected.models.length > 0)
    assert(detected.models.every(model => model.modelId.includes('::')))
    assert.equal(modelId(...detected.models[0]!.modelId.split('::') as [string, string]), detected.models[0]!.modelId)
  }
})
