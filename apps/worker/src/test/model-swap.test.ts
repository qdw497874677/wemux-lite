import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentKey, ModelId, SessionId, WorkerId, WorkspaceId } from '@wemux/domain'
import { SqliteWorkerStore } from '../storage/sqlite-store.js'

test('setModel persists the binding and records model.changed in the Journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wemux-model-swap-'))
  const store = new SqliteWorkerStore(join(directory, 'worker.sqlite'))
  const sessionId = 'session-model-swap' as SessionId
  const previousModelId = 'openai::old' as ModelId
  const modelId = 'openai::new' as ModelId
  try {
    await store.transaction(async tx => {
      await tx.sessions.createSession(sessionId, {
        workspaceId: 'workspace-model-swap' as WorkspaceId,
        agent: { workerId: 'worker-model-swap' as WorkerId, agentKey: 'pi' as AgentKey },
        modelId: previousModelId,
      })
      await tx.sessions.setModel(sessionId, modelId)
    })

    const session = await store.sessions.get(sessionId)
    assert.equal(session?.binding.modelId, modelId)
    const journal = await store.journal.read({ sessionId, fromSeq: 1 as never, limit: 10 })
    assert.deepEqual(journal.events.at(-1)?.payload, { kind: 'model.changed', previousModelId, modelId })
  } finally {
    store.close()
  }
})
