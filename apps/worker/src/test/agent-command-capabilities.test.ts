import assert from 'node:assert/strict'
import test from 'node:test'
import { PiAgent } from '../agents/pi-agent.js'
import { ClaudeAgent } from '../agents/claude-agent.js'
import { OpenCodeAgent } from '../agents/opencode-agent.js'
import { TestAgent } from '../agents/test-agent.js'

async function commandDetection(command: string) {
  if (command === 'pi') return new PiAgent('/definitely-missing-wemux-pi').detect()
  if (command === 'claude') return new ClaudeAgent('/definitely-missing-wemux-claude').detect()
  return new OpenCodeAgent('/definitely-missing-wemux-opencode').detect()
}

test('pi and claude advertise native slash compaction even when unavailable', async () => {
  const pi = await commandDetection('pi')
  const claude = await commandDetection('claude')
  assert.deepEqual(pi.agentCommands, ['/compact', '/model'])
  assert.equal(pi.compactMode, 'slash-command')
  assert.deepEqual(claude.agentCommands, ['/compact', '/model', '/clear'])
  assert.equal(claude.compactMode, 'slash-command')
})

test('opencode and deterministic test agent honestly advertise no native slash commands', async () => {
  const opencode = await commandDetection('opencode')
  const echo = await new TestAgent().detect()
  assert.deepEqual(opencode.agentCommands, [])
  assert.deepEqual(echo.agentCommands, [])
  assert.equal(opencode.compactMode, undefined)
  assert.equal('compactMode' in echo ? echo.compactMode : undefined, undefined)
})
