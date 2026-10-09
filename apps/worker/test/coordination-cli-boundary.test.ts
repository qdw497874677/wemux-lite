import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesystemAgentLaunchContextProvider } from '../src/application/agent-launch-context-provider.ts'
import { PiRuntimeSessionAdapter } from '../src/agents/pi-runtime-session-adapter.ts'
import { ClaudeRuntimeSessionAdapter } from '../src/agents/claude-runtime-session-adapter.ts'
import { OpenCodeRuntimeSessionAdapter } from '../src/agents/opencode-runtime-session-adapter.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

test('public Pi, Claude and OpenCode CLI launch boundaries scope coordination and preserve ordinary ambient env', async t => {
  const home = await mkdtemp(join(tmpdir(), 'wemux-cli-scope-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const workspaceId = 'workspace-fixture'
  const cwd = join(home, 'workspaces', hash(workspaceId))
  await mkdir(cwd, { recursive: true })
  const cli = join(home, 'fake-cli.cjs')
  const output = join(home, 'observation.json')
  // One public executable per adapter; Pi speaks its RPC protocol, while the other
  // two adapters consume the normal JSON-line CLI output from this fixture.
  await writeFile(cli, `#!/usr/bin/env node
const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({cwd:process.cwd(),home:process.env.HOME,pi:process.env.PI_CODING_AGENT_DIR,claude:process.env.CLAUDE_CONFIG_DIR,marker:process.env.WEMUX_HOST_CREDENTIAL_MARKER||null,path:!!process.env.PATH}));
if(process.argv.includes('--mode')) process.stdin.on('data',()=>process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'ok'}})+'\\n'+JSON.stringify({type:'agent_settled'})+'\\n'));
else if(process.argv[2]==='run') process.stdout.write(JSON.stringify({type:'text',part:{text:'ok'}})+'\\n'+JSON.stringify({type:'step_finish',part:{reason:'stop'}})+'\\n');
else process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'ok'}]}})+'\\n'+JSON.stringify({type:'result'})+'\\n');
`, { mode: 0o755 })
  const original = process.env.WEMUX_HOST_CREDENTIAL_MARKER
  process.env.WEMUX_HOST_CREDENTIAL_MARKER = 'host-secret'
  t.after(() => { if (original === undefined) delete process.env.WEMUX_HOST_CREDENTIAL_MARKER; else process.env.WEMUX_HOST_CREDENTIAL_MARKER = original })
  const adapters = [new PiRuntimeSessionAdapter(cli), new ClaudeRuntimeSessionAdapter(cli), new OpenCodeRuntimeSessionAdapter(cli)]
  for (const [index, adapter] of adapters.entries()) {
    const sessionId = `coord-${index}`
    const provider = new FilesystemAgentLaunchContextProvider(home, null, undefined, undefined, async () => ({ projectId: 'team:team-1' as never, workspaceId, rootPath: cwd, agentKey: 'pi' as never }))
    const prepared = await provider.prepare({ id: `turn-${index}`, sessionId, capabilitySnapshot: { id: 'scope', projectId: 'team:team-1', workspaceId, sessionId, assets: [], allowedTools: [], allowedConnectorIds: [] } } as never)
    const session = await adapter.openSession({ sessionId: sessionId as never, cwd, modelId: null, resume: null })
    try {
      const handle = await session.execute({ operationId: `turn-${index}` as never, message: { messageId: 'message' as never, content: 'hello' }, launchContext: prepared.context })
      for await (const _ of handle.signals) { /* consume public CLI output */ }
      const observed = JSON.parse(await readFile(output, 'utf8'))
      assert.equal(observed.cwd, cwd)
      assert.equal(observed.home, prepared.context!.environment.HOME)
      assert.equal(observed.pi, prepared.context!.environment.PI_CODING_AGENT_DIR)
      assert.equal(observed.claude, prepared.context!.environment.CLAUDE_CONFIG_DIR)
      assert.equal(observed.marker, null)
      assert.equal(observed.path, true)
    } finally { await session.close(); await prepared.cleanup() }
  }
  const ordinary = await new ClaudeRuntimeSessionAdapter(cli).openSession({ sessionId: 'ordinary' as never, cwd, modelId: null, resume: null })
  try {
    const handle = await ordinary.execute({ operationId: 'ordinary-turn' as never, message: { messageId: 'message' as never, content: 'hello' }, launchContext: null })
    for await (const _ of handle.signals) { /* consume */ }
    assert.equal(JSON.parse(await readFile(output, 'utf8')).marker, 'host-secret')
  } finally { await ordinary.close() }
})

test('restricted session home refuses symlink components outside verified workspace', async t => {
  const { symlink } = await import('node:fs/promises')
  const home = await mkdtemp(join(tmpdir(), 'wemux-home-symlink-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const workspaceId = 'symlink-fixture'
  const cwd = join(home, 'workspaces', hash(workspaceId))
  const outside = join(home, 'outside')
  await mkdir(cwd, { recursive: true })
  await mkdir(outside)
  await symlink(outside, join(cwd, '.wemux-agent'))
  const sessionId = 'symlink-session'
  const provider = new FilesystemAgentLaunchContextProvider(home, null, undefined, undefined, async () => ({ projectId: 'team:team-1' as never, workspaceId, rootPath: cwd, agentKey: 'pi' as never }))
  await assert.rejects(provider.prepare({ id: 'symlink-turn', sessionId, capabilitySnapshot: { id: 'scope', projectId: 'team:team-1', workspaceId, sessionId, assets: [], allowedTools: [], allowedConnectorIds: [] } } as never), /agent_launch_home_mismatch/)
  await assert.rejects(readFile(join(outside, hash(sessionId), 'models.json')), { code: 'ENOENT' })
})
