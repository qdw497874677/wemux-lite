/// <reference types="node" />

import assert from 'node:assert/strict'
import test from 'node:test'
import type { HttpConnectorDefinition } from '@wemux/connector'
import { parseServerTransportFrame, parseWorkerTransportFrame, type ServerToWorkerFrame, type WorkerToServerFrame } from './index.js'

const occurredAt = '2026-01-01T00:00:00.000Z' as never
const definition: HttpConnectorDefinition = {
  id: 'conn-1' as never,
  projectId: 'project-1' as never,
  name: 'Health',
  description: null,
  revision: 2,
  enabled: true,
  allowedWorkerIds: ['worker-1' as never],
  credentialRef: 'service-ref' as never,
  credentialAvailability: 'available',
  riskDefaults: { requireApprovalForRead: true, allowMcpReadOnlyHint: false },
  createdAt: occurredAt,
  updatedAt: occurredAt,
  kind: 'http',
  config: {
    baseUrl: 'https://example.com/',
    authentication: 'api_key',
    publicHeaders: {},
    allowedOperations: [{
      id: 'health',
      description: 'Check health',
      method: 'GET',
      pathTemplate: '/health',
      allowedQueryNames: [],
      allowedRequestHeaderNames: [],
      requestContentTypes: [],
      operationTypeOverride: null,
    }],
    allowPrivateNetwork: false,
  },
}

function serverFrame(): ServerToWorkerFrame {
  return {
    frameType: 'data',
    durability: 'durable',
    deliveryEpoch: 'server-epoch',
    directionSeq: 1,
    messageId: 'message-1' as never,
    lane: 'command',
    payloadVersion: 'wemux.server.payload.v1',
    expiresAt: null,
    payload: {
      type: 'command',
      commandId: 'command-1' as never,
      command: { kind: 'connector.definition.sync', requestId: 'request-1', definition },
    },
  }
}

function workerFrame(): WorkerToServerFrame {
  return {
    frameType: 'data',
    durability: 'durable',
    deliveryEpoch: 'worker-epoch',
    directionSeq: 1,
    messageId: 'message-2' as never,
    lane: 'snapshot',
    payloadVersion: 'wemux.worker.payload.v1',
    expiresAt: null,
    payload: {
      type: 'event',
      scope: 'connector',
      report: {
        requestId: 'request-1',
        connectorId: definition.id,
        projectId: definition.projectId,
        workerId: 'worker-1' as never,
        revision: 2,
        status: 'test_succeeded',
        credentialAvailability: 'available',
        message: 'HTTP 200',
        errorCode: null,
        occurredAt,
      },
    },
  }
}

test('connector definition sync carries only the public credential reference', () => {
  const message = parseServerTransportFrame(serverFrame())
  assert.equal(message.frameType, 'data')
  if (message.frameType !== 'data' || !('payload' in message) || message.payload.type !== 'command' || message.payload.command.kind !== 'connector.definition.sync') {
    return assert.fail('expected connector.definition.sync command')
  }
  assert.equal(message.payload.command.definition.credentialRef, 'service-ref')
  const json = JSON.stringify(message)
  for (const forbidden of ['api' + 'Key', 'app' + 'Secret', 'authoriz' + 'ation', 'cipher' + 'text']) {
    assert.equal(json.toLowerCase().includes(forbidden.toLowerCase()), false)
  }
})

test('connector report uses the event payload and transport parser rejects unknown frame fields', () => {
  const message = parseWorkerTransportFrame(workerFrame())
  assert.equal(message.frameType, 'data')
  if (message.frameType !== 'data' || !('payload' in message) || message.payload.type !== 'event' || message.payload.scope !== 'connector') {
    return assert.fail('expected connector report event')
  }
  assert.equal(message.payload.report.status, 'test_succeeded')
  assert.throws(
    () => parseWorkerTransportFrame({ ...workerFrame(), unexpected: 'nope' }),
    /Invalid Worker transport v2 frame/,
  )
})
