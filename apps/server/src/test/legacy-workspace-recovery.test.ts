import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import type { CommandId, Timestamp, WorkerId, WorkspaceId } from '@wemux/domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { ServerService, newId } from '../application/server-service.js'
import { WorkerService } from '../application/worker-service.js'
import { Notifications } from '../application/notifications.js'

const workspaceId = 'legacy-workspace' as WorkspaceId
const workerId = 'legacy-worker' as WorkerId
const legacyCommandId = 'legacy-provision' as CommandId

for (const workspaceStatus of ['pending', 'failed'] as const) {
  for (const commandStatus of ['pending', 'accepted', 'rejected', 'completed', 'failed', 'cancelled', 'none'] as const) {
    test(`v1 SQLite ${workspaceStatus} workspace without provisioning / ${commandStatus} history: recovery correlation survives restart`, async () => {
      const directory = await mkdtemp('/tmp/t04-v1-recovery-')
      const path = `${directory}/server.sqlite`
      let store: SqliteServerStore | undefined
      try {
        // Build the old schema directly, never by stripping fields from a current store.
        const db = new DatabaseSync(path)
        try {
          db.exec(await readFile(new URL('./fixtures/legacy-workspace-v1.sql', import.meta.url), 'utf8'))
          db.prepare("UPDATE records SET data=json_set(data,'$.status',?) WHERE kind='workspace'").run(workspaceStatus)
          if (commandStatus === 'none') db.exec('DELETE FROM commands')
          else db.prepare("UPDATE commands SET status=?, projection=json_set(projection,'$.status',?)").run(commandStatus, commandStatus)
          assert.deepEqual(db.prepare('SELECT version FROM schema_migrations').all().map(row => row.version), [1])
          assert.equal(db.prepare("SELECT json_type(data,'$.provisioning') AS type FROM records WHERE kind='workspace'").get()!.type, null)
        } finally { db.close() }

        store = new SqliteServerStore(path) // Real migrations, then application bootstrap.
        let server = new ServerService(store, new Notifications())
        await server.bootstrap()
        assert.equal((await store.resources.getWorkspace(workspaceId))!.provisioning, undefined)
        assert.equal((await store.commands.get(legacyCommandId))?.status, commandStatus === 'none' ? undefined : commandStatus)
        const recovered = await server.reprovisionWorkspace(workspaceId, 'first-recovery')
        assert.equal(recovered.created, true)
        assert.notEqual(recovered.commandId, legacyCommandId)
        assert.equal((await server.reprovisionWorkspace(workspaceId, 'first-recovery')).commandId, recovered.commandId)
        assert.equal((await server.reprovisionWorkspace(workspaceId, 'network-retry')).commandId, recovered.commandId)
        assert.equal((await store.commands.list({ limit: 100 })).length, commandStatus === 'none' ? 1 : 2)

        store.close(); store = undefined
        store = new SqliteServerStore(path)
        server = new ServerService(store, new Notifications())
        await server.bootstrap()
        const before = await store.resources.getWorkspace(workspaceId)
        assert.equal(before!.provisioning!.commandId, recovered.commandId)
        for (const request of ['first-recovery', 'network-retry', 'after-restart']) {
          const retry = await server.reprovisionWorkspace(workspaceId, request)
          assert.equal(retry.created, false)
          assert.equal(retry.commandId, recovered.commandId)
        }
        const current = await store.resources.getWorkspace(workspaceId)
        const worker = new WorkerService(store, new Notifications())
        const report = async (commandId: string | undefined, status: 'provisioning' | 'failed' | 'ready') => worker.receive(workerId, {
          protocolVersion: 1, messageId: newId<'MessageId'>(), type: 'event', scope: 'workspace',
          report: { workspaceId, ...(commandId ? { commandId: commandId as CommandId } : {}), status, reason: null, location: null,
            // Newer than startedAt: rejection must be based on identity, not time.
            occurredAt: '2099-01-01T00:00:00.000Z' as Timestamp },
        })
        if (commandStatus !== 'none') {
          for (const status of ['provisioning', 'failed', 'ready'] as const) {
            await report(undefined, status)
            assert.deepEqual(await store.resources.getWorkspace(workspaceId), current, `uncorrelated ${status} must not mutate the replacement`)
          }
          await report(legacyCommandId, 'ready')
          assert.deepEqual(await store.resources.getWorkspace(workspaceId), current)
          assert.equal(current!.provisioning!.replacedAttempt, true)
        } else {
          // No historical command: genuinely first attempt must support old Workers.
          assert.equal(current!.provisioning!.replacedAttempt, false)
          await report(undefined, 'provisioning')
          assert.equal((await store.resources.getWorkspace(workspaceId))!.status, 'provisioning')
          await report(undefined, 'ready')
          assert.equal((await store.resources.getWorkspace(workspaceId))!.status, 'ready')
        }
        await report(recovered.commandId, 'ready')
        const ready = await store.resources.getWorkspace(workspaceId)
        assert.equal(ready!.status, 'ready')
        assert.equal(ready!.provisioning!.reportedAt, '2099-01-01T00:00:00.000Z')
        assert.equal((await store.commands.list({ limit: 100 })).length, commandStatus === 'none' ? 1 : 2)
        store.close(); store = undefined
        store = new SqliteServerStore(path)
        assert.deepEqual(await store.resources.getWorkspace(workspaceId), ready)
      } finally { store?.close(); await rm(directory, { recursive: true, force: true }) }
    })
  }
}
