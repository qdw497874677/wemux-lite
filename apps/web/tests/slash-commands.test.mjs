import assert from 'node:assert/strict'
import test from 'node:test'
import { commandGroups, commandsForAgent, compactRoute, isAgentCommandInput } from '../src/features/sessions/slash-commands.ts'

const pi = { agentKey: 'pi', displayName: 'Pi', agentCommands: ['/compact', '/model', 'clear'], compactMode: 'slash-command' }

test('slash command panel groups platform and agent-native commands', () => {
  const groups = commandGroups(commandsForAgent(pi), '/')
  assert.deepEqual(groups.map(group => [group.label, group.commands.map(command => command.name)]), [
    ['', ['/compact', '/stop', '/help']],
    ['Agent ', ['/model', '/clear']],
  ])
  assert.equal(groups[1].commands[0].description, ' Pi ')
})

test('agent commands are normalized and duplicate platform commands are not repeated', () => {
  assert.deepEqual(commandsForAgent(pi).map(command => command.name), ['/compact', '/stop', '/help', '/model', '/clear'])
})

test('compact routing defaults to native and honors slash-command capability', () => {
  assert.equal(compactRoute(pi), 'slash-command')
  assert.equal(compactRoute({ ...pi, compactMode: 'native' }), 'native')
  assert.equal(compactRoute(undefined), 'native')
})

test('only declared agent commands may pass through as ordinary messages', () => {
  assert.equal(isAgentCommandInput(pi, '/model sonnet'), true)
  assert.equal(isAgentCommandInput(pi, '/compact now'), true)
  assert.equal(isAgentCommandInput(pi, '/unknown'), false)
  assert.equal(isAgentCommandInput({ ...pi, agentCommands: ['/stop'] }, '/stop'), false)
  assert.equal(isAgentCommandInput(undefined, '/compact'), false)
})
