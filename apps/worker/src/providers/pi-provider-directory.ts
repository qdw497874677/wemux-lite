import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertModelProviderConfig, type ModelProviderResourceDefinition } from '@wemux/domain'

/** Pi 0.87.1-compatible, fail-closed subset; does not promise remote authentication. */
export async function preparePiProviderDirectory(definition: ModelProviderResourceDefinition, parent = tmpdir()): Promise<{ readonly directory: string; readonly modelId: string; cleanup(): Promise<void> }> {
  assertModelProviderConfig(definition)
  // Do not synthesize an Anthropic-compatible API from a generic endpoint,
  // infer capability metadata for multiple models, or inherit user auth.json.
  if (definition.providerKey !== 'openai-compatible' || definition.modelIds.length !== 1 || definition.agentKeys.length !== 1 || definition.agentKeys[0] !== 'pi' || definition.credential.variableNames.length !== 1 || definition.credential.variableNames[0] !== 'OPENAI_API_KEY') throw new Error('pi_provider_configuration_unsupported')
  const directory = await mkdtemp(join(parent, 'wemux-pi-provider-'))
  try {
    const variable = definition.credential.variableNames[0]!
    const document = { providers: { 'openai-compatible': {
      baseUrl: definition.endpoint,
      api: 'openai-completions',
      apiKey: `$${variable}`,
      models: [{ id: definition.modelIds[0]! }],
    } } }
    await writeFile(join(directory, 'models.json'), JSON.stringify(document), { mode: 0o600, flag: 'wx' })
    return { directory, modelId: `openai-compatible::${definition.modelIds[0]}`, cleanup: () => rm(directory, { recursive: true, force: true }) }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
