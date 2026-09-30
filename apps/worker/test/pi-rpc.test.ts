import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, chmod, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { PiAgent } from '../src/agents/pi-agent.js'
import { PiRpc } from '../src/agents/pi-rpc.js'
import type { AgentTurnInput, AgentSignal } from '../src/application/ports/agent-adapter.js'

async function fixture(mode = 'ok', version = '0.85.1') {
  const cwd = await mkdtemp(join(tmpdir(), 'wemux-pi-rpc-test-'))
  const executable = join(cwd, 'pi')
  await writeFile(executable, String.raw`#!${process.execPath}
import { writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const mode = ${JSON.stringify(mode)};
process.chdir(${JSON.stringify(cwd)});
if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }
const args = process.argv.slice(2);
await writeFile('argv.json', JSON.stringify({args, env: process.env.WEMUX_ASSETS_ROOT, pid: process.pid}));
const tools = []; const hooks = []; let restricted = false;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const runHooks = async event => {
  for (const [name, hook] of hooks) if (event === name) {
    try { await hook(); } catch (error) { send({type:'extension_error',error:error.message}); }
  }
};
const extension = args[args.indexOf('--extension') + 1];
if (args.includes('--extension') && (await readFile(extension, 'utf8')).includes('secret')) throw new Error('credential leaked to extension');
if (args.includes('--extension') && mode !== 'no-extension') {
  (await import(pathToFileURL(extension))).default({registerTool: t => tools.push(t), getActiveTools: () => restricted ? ['read'] : tools.map(t => t.name), setActiveTools: () => { throw new Error('must not override restriction'); }, on: (event, fn) => hooks.push([event, fn])});
  await runHooks('session_start');
}
if (mode === 'descendant' || mode === 'orphan-pipe') {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {detached:true, stdio:['ignore', 'inherit', 'inherit']});
  child.unref();
  await writeFile('descendant.json', JSON.stringify({pid:child.pid}));
  if (mode === 'orphan-pipe') process.exit(9);
  process.on('SIGTERM', () => {});
}
const sessionFile = args.includes('--session') ? args[args.indexOf('--session') + 1] : process.cwd() + '/session.jsonl';
const persist = async () => {
  if (mode === 'invalid-session') return writeFile(sessionFile, '{invalid');
  await writeFile(sessionFile, JSON.stringify({type:'session', version:3, id:'native'}) + '\n' + JSON.stringify({type:'message',id:'a',parentId:null,message:{role:'assistant',content:[]}}) + '\n');
};
for await (const line of createInterface({input: process.stdin})) {
 const req = JSON.parse(line);
 await writeFile('requests.jsonl', JSON.stringify(req) + '\n', {flag:'a'});
 if (mode === 'timeout') continue;
 let data;
 if (req.type === 'get_available_models') data = {models: mode === 'no-auth' ? [] : [{provider:'fixture',id:'model',name:'Fixture'}]};
 if (req.type === 'get_state') data = {sessionFile};
 if (req.type === 'set_model' && (req.provider !== 'fixture' || req.modelId !== 'model')) process.exit(8);
 send({type:'response',id:req.id,command:req.type,success: !(mode === 'reject' && req.type === 'prompt'), error:'rejected',data});
 if (req.type === 'prompt') {
  if (mode === 'reject' || mode === 'hang' || mode === 'descendant') continue;
  if (mode === 'exit') process.exit(7);
  if (mode === 'remove-before') restricted = true;
  await runHooks('before_agent_start');
  await runHooks('agent_start');
  if (mode === 'remove-after') restricted = true;
  await runHooks('turn_start');
  if (mode === 'remove-idle') { restricted = true; continue; }
  if (mode.startsWith('remove-')) continue;
  await persist();
  if (mode === 'partial-hang') continue;
  if (mode === 'partial-exit') process.exit(7);
  send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Hi 😀\u2028there'}});
  send({type:'tool_execution_start',toolCallId:'t',toolName:'read',args:{path:'x'}});
  for (const text of ['a', 'ab', 'ab']) send({type:'tool_execution_update',toolCallId:'t',partialResult:{content:[{type:'text',text}]}});
  if (tools.length) await tools[0].execute('t', {});
  if (mode === 'nonprefix') send({type:'tool_execution_update',toolCallId:'t',partialResult:{content:[{type:'text',text:'x'}]}});
  const result = {content:[{type:'text',text:mode === 'nonprefix' ? 'xy' : 'abc'}]};
  send({type:'tool_execution_end',toolCallId:'t',result,isError:false});
  send({type:'agent_end',messages:[{role:'assistant',stopReason:'error',errorMessage:'transient'}],willRetry:true});
  const message = {role:'assistant',stopReason:mode === 'error' ? 'error' : 'stop',errorMessage:'model failed'};
  send({type:'message_end',message});
  send({type:'agent_end',messages:[message],willRetry:false});
  await runHooks('agent_settled');
  if (mode !== 'legacy') send({type:'agent_settled'});
 }
}
`)
  await chmod(executable, 0o755)
  const input: AgentTurnInput = { sessionId: 's' as any, turnId: 't' as any, cwd, modelId: 'fixture::model' as any, message: { messageId: 'm' as any, content: 'hello' }, resume: null, launchContext: null }
  return { cwd, executable, input, agent: new PiAgent(executable, 1000, 3000), close: () => rm(cwd, { recursive: true, force: true }) }
}
async function collect(handle: Awaited<ReturnType<PiAgent['startTurn']>>) {
  const signals: AgentSignal[] = []
  for await (const signal of handle.signals) signals.push(signal)
  return signals
}

for (const version of ['0.80.3', '0.80.4', '0.85.0', '0.85.1-beta.1', 'unknown']) test(`Pi rejects unsupported version ${version} at detection and startup`, async () => {
  const f = await fixture('legacy', version)
  try {
    const detection = await f.agent.detect()
    assert.equal(detection.availability.status, 'unavailable')
    assert.match(detection.diagnostics.join(' '), /upgrade to Pi >=0\.85\.1/)
    await assert.rejects(f.agent.startTurn(f.input), /upgrade to Pi >=0\.85\.1/)
    await assert.rejects(access(join(f.cwd, 'argv.json'))) // Never starts incompatible RPC.
  } finally { await f.close() }
})

test('Pi cumulative snapshots emit suffixes and explicitly delimit replacements', async () => {
  const f = await fixture('nonprefix')
  try {
    const signals = await collect(await f.agent.startTurn(f.input))
    assert.equal(signals.filter(s => s.kind === 'event' && s.event.kind === 'tool.output.delta').map(s => (s as any).event.text).join(''), 'ab\n[Pi tool output replaced]\nxy')
  } finally { await f.close() }
})

for (const mode of ['reject', 'exit', 'hang', 'invalid-session', 'error', 'partial-exit', 'partial-hang']) test(`Pi publishes only persisted valid sessions at finish: ${mode}`, async () => {
  const f = await fixture(mode)
  try {
    const handle = await f.agent.startTurn(f.input)
    if (mode === 'hang' || mode === 'partial-hang') {
      if (mode === 'partial-hang') await waitForFile(join(f.cwd, 'session.jsonl'))
      await handle.stop()
    }
    const signals = await collect(handle)
    const native = signals.find(s => s.kind === 'native-session')
    const persisted = ['error', 'partial-exit', 'partial-hang'].includes(mode)
    assert.equal(Boolean(native), persisted)
    if (native?.kind === 'native-session') {
      assert.equal(signals.at(-2), native)
      assert.equal(JSON.parse((await readFile(native.nativeSession, 'utf8')).split('\n')[0]!).type, 'session')
    } else {
      // Ordinary Session reuse passes null again, not an allocated nonexistent path.
      const again = await f.agent.startTurn({ ...f.input, resume: null })
      await again.stop(); await collect(again)
    }
  } finally { await f.close() }
})

async function waitForFile(path: string) {
  for (let i = 0; i < 100; i++) {
    try { await access(path); return } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
  }
  throw new Error(`Fixture did not create ${path}`)
}

async function waitForDescendantPid(path: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (parsed && typeof parsed === 'object' && 'pid' in parsed && typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0) return parsed.pid
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Fixture did not write complete descendant metadata to ${path}`)
}

for (const mode of ['remove-before', 'remove-after', 'remove-idle']) test(`Pi fails runtime capability removal without restoring restricted tools: ${mode}`, async () => {
  const f = await fixture(mode)
  try {
    const handle = await f.agent.startTurn({ ...f.input, launchContext: { capabilityEndpoint: 'http://127.0.0.1:1', capabilityToken: 'secret', environment: {} } as any })
    const signals = await collect(handle)
    assert.equal((signals.at(-1) as any).outcome.status, 'failed')
    assert.match((signals.at(-1) as any).outcome.failure.message, /inactive|restrictions/)
    assert(!signals.some(s => s.kind === 'native-session'))
    const { args } = JSON.parse(await readFile(join(f.cwd, 'argv.json'), 'utf8'))
    await assert.rejects(access(args[args.indexOf('--extension') + 1]))
  } finally { await f.close() }
})

test('Pi fixture waits for complete descendant metadata rather than file creation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-pi-metadata-'))
  const path = join(dir, 'descendant.json')
  let complete: Promise<void> | undefined
  try {
    await writeFile(path, '')
    complete = new Promise<void>((resolve, reject) => setTimeout(() => { void writeFile(path, JSON.stringify({ pid: 123 })).then(resolve, reject) }, 50))
    const pid = await waitForDescendantPid(path)
    assert.equal(pid, 123)
  } finally {
    await complete
    await rm(dir, { recursive: true, force: true })
  }
})

for (const mode of ['descendant', 'orphan-pipe']) test(`Pi teardown is bounded with detached inherited pipes: ${mode}`, { skip: process.platform !== 'linux', timeout: 5000 }, async () => {
  const f = await fixture(mode)
  let descendant: number | undefined
  const rpc = new PiRpc(f.executable, [], f.cwd, process.env, 1000)
  try {
    descendant = await waitForDescendantPid(join(f.cwd, 'descendant.json'))
    if (mode === 'descendant') await rpc.request('get_state')
    const started = Date.now()
    await rpc.close(); await rpc.close()
    assert(Date.now() - started < 1500)
    if (mode === 'descendant') {
      // A killed orphan may remain a zombie until this host's PID 1 reaps it.
      for (let i = 0; i < 100; i++) {
        let stat = ''
        try { stat = await readFile(`/proc/${descendant}/stat`, 'utf8') } catch { break }
        if (stat.includes(') Z ')) break
        if (i === 99) assert.fail('detached descendant survived teardown')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
  } finally {
    await rpc.close()
    if (descendant) { try { process.kill(descendant, 'SIGKILL') } catch { /* already gone */ } }
    await f.close()
  }
})

test('Pi missing executable is unavailable and start fails without installing', async () => {
  const agent = new PiAgent('/nonexistent/wemux-pi')
  assert.equal((await agent.detect()).availability.status, 'unavailable')
  const f = await fixture()
  try { await assert.rejects(agent.startTurn(f.input), /executable not found/) } finally { await f.close() }
})
test('Pi CLI detects version, executable and RPC authenticated model inventory', async () => {
  const f = await fixture()
  try {
    const detection = await f.agent.detect()
    assert.equal(detection.executablePath, f.executable)
    assert.equal(detection.version, '0.85.1')
    assert.equal(detection.models[0]?.modelId, 'fixture::model')
  } finally { await f.close() }
})
test('Pi no authenticated models reports authentication required', async () => {
  const f = await fixture('no-auth')
  try {
    const detection = await f.agent.detect()
    assert.equal(detection.availability.status, 'authentication-required')
    assert.equal(detection.authorization?.state, 'unauthorized')
    await assert.rejects(f.agent.startTurn(f.input), /authenticated/)
  } finally { await f.close() }
})
test('Pi streams text and tools, waits through retries, resumes exact session and selects model', async () => {
  const f = await fixture()
  try {
    const signals = await collect(await f.agent.startTurn(f.input))
    assert(signals.some(s => s.kind === 'event' && s.event.kind === 'assistant.text.delta' && s.event.text === 'Hi 😀\u2028there'))
    assert.equal(signals.filter(s => s.kind === 'event' && s.event.kind === 'tool.output.delta').map(s => (s as any).event.text).join(''), 'abc')
    assert(signals.some(s => s.kind === 'event' && s.event.kind === 'tool.finished'))
    assert.deepEqual(signals.at(-1), { kind: 'finished', outcome: { status: 'completed' } })
    const native = signals.find(s => s.kind === 'native-session')!
    assert(native.kind === 'native-session')
    const resumed = await collect(await f.agent.startTurn({ ...f.input, resume: native.nativeSession }))
    assert(!resumed.some(s => s.kind === 'native-session'))
    assert(JSON.parse(await readFile(join(f.cwd, 'argv.json'), 'utf8')).args.includes(native.nativeSession))
    const requests = (await readFile(join(f.cwd, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert(requests.some(r => r.type === 'set_model' && r.provider === 'fixture' && r.modelId === 'model'))
    await assert.rejects(f.agent.startTurn({ ...f.input, modelId: 'fixture::missing' as any }), /authenticated/)
  } finally { await f.close() }
})
for (const mode of ['error', 'reject', 'exit']) test(`Pi reports ${mode} as failure`, async () => {
  const f = await fixture(mode)
  try { const signals = await collect(await f.agent.startTurn(f.input)); assert.equal((signals.at(-1) as any).outcome.status, 'failed') } finally { await f.close() }
})
test('Pi cancellation aborts then kills the subprocess, idempotently', async () => {
  const f = await fixture('hang')
  try {
    const handle = await f.agent.startTurn(f.input)
    await handle.stop(); await handle.stop()
    assert.deepEqual((await collect(handle)).at(-1), { kind: 'finished', outcome: { status: 'cancelled' } })
    const { pid } = JSON.parse(await readFile(join(f.cwd, 'argv.json'), 'utf8'))
    assert.throws(() => process.kill(pid, 0))
    assert.match(await readFile(join(f.cwd, 'requests.jsonl'), 'utf8'), /"type":"abort"/)
  } finally { await f.close() }
})
test('Pi RPC startup timeout and turn timeout clean up subprocesses', async () => {
  for (const mode of ['timeout', 'hang']) {
    const f = await fixture(mode)
    try {
      const agent = new PiAgent(f.executable, 300, 300)
      if (mode === 'timeout') await assert.rejects(agent.startTurn(f.input), /timed out/)
      else assert.equal(((await collect(await agent.startTurn(f.input))).at(-1) as any).outcome.status, 'failed')
      const { pid } = JSON.parse(await readFile(join(f.cwd, 'argv.json'), 'utf8'))
      assert.throws(() => process.kill(pid, 0))
    } finally { await f.close() }
  }
})
test('Pi loads real generated extension across process boundary, injects launch resources and removes secrets', async () => {
  let invoked = false
  const server = createServer((req, res) => { invoked = req.url === '/session.info' && req.headers.authorization === 'Bearer secret'; res.setHeader('content-type', 'application/json'); res.end('{"ok":true}') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try { for (const mode of ['ok', 'no-extension']) {
    const f = await fixture(mode)
    try {
      const launchContext = { assetsRoot: f.cwd, skillsRoot: f.cwd, instructions: 'workspace instructions', capabilityEndpoint: `http://127.0.0.1:${port}`, capabilityToken: 'secret', capabilitySnapshot: {} as any, environment: { WEMUX_ASSETS_ROOT: f.cwd } }
      if (mode === 'ok') {
        assert.equal(((await collect(await f.agent.startTurn({ ...f.input, launchContext }))).at(-1) as any).outcome.status, 'completed')
        assert(invoked)
      } else await assert.rejects(f.agent.startTurn({ ...f.input, launchContext }), /did not load/)
      const { args, env } = JSON.parse(await readFile(join(f.cwd, 'argv.json'), 'utf8'))
      assert.equal(env, f.cwd)
      assert(args.includes('--skill')); assert(args.includes('workspace instructions')); assert(!args.includes('secret'))
      await assert.rejects(access(args[args.indexOf('--extension') + 1]))
    } finally { await f.close() }
  }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
