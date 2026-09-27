import assert from 'node:assert/strict'
import test from 'node:test'
import { stableFingerprint } from '@wemux/connector'
import type { ProjectId, UserId } from '@wemux/domain'
import { Notifications } from './notifications.js'
import type { ProjectAccessService } from './project-access-service.js'
import { ConnectorService } from './connector-service.js'
import type { WorkerAccessService } from './worker-access-service.js'
import { SqliteConnectorRepository } from '../storage/sqlite/connector-repository.js'
import { SqliteServerStore } from '../storage/sqlite/store.js'

const actorId = 'user-1' as UserId
const projectId = 'project-1' as ProjectId
const definition = {
  name: 'Health',
  description: null,
  enabled: true,
  allowedWorkerIds: [],
  credentialRef: null,
  riskDefaults: { requireApprovalForRead: true, allowMcpReadOnlyHint: false },
  kind: 'http' as const,
  config: {
    baseUrl: 'https://example.com/',
    authentication: 'none' as const,
    publicHeaders: {},
    allowedOperations: [{
      id: 'health',
      description: 'Check health',
      method: 'GET' as const,
      pathTemplate: '/health',
      allowedQueryNames: [],
      allowedRequestHeaderNames: [],
      requestContentTypes: [],
      operationTypeOverride: null,
    }],
    allowPrivateNetwork: false,
  },
}

const projects = {
  require: async () => ({ id: projectId, accessRole: 'manager' as const }),
} as unknown as ProjectAccessService
const workers = {
  require: async () => ({ id: 'worker-1', accessRole: 'use' as const }),
} as unknown as WorkerAccessService

function fingerprint(value: unknown): string {
  return stableFingerprint(value)
}

test('ConnectorService provides idempotency, fingerprint conflict, and CAS', async () => {
  const store = new SqliteServerStore(':memory:')
  const repository = new SqliteConnectorRepository(':memory:')
  const service = new ConnectorService(repository, store, projects, workers, new Notifications())
  const createInput = {
    projectId,
    requestId: 'request-1',
    expectedRevision: null,
    definition,
    fingerprint: fingerprint({ operation: 'create', definition }),
  }

  try {
    const created = await service.create(actorId, createInput)
    const replayed = await service.create(actorId, createInput)
    assert.equal(replayed.definition.id, created.definition.id)
    assert.equal(replayed.replayed, true)

    const changedDefinition = { ...definition, name: 'Different' }
    await assert.rejects(
      service.create(actorId, {
        ...createInput,
        definition: changedDefinition,
        fingerprint: fingerprint({ operation: 'create', definition: changedDefinition }),
      }),
      /requestId fingerprint conflict/,
    )

    await assert.rejects(
      service.update(actorId, {
        projectId,
        requestId: 'request-2',
        connectorId: created.definition.id,
        expectedRevision: 99,
        definition,
        fingerprint: fingerprint({
          operation: 'update',
          connectorId: created.definition.id,
          expectedRevision: 99,
          definition,
        }),
      }),
      /revision conflict/i,
    )
  } finally {
    repository.close()
    await store.close()
  }
})
