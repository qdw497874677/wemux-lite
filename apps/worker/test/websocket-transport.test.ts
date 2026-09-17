import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import type { WorkerId } from '@wemux/domain'
import { WebSocketTransport } from '../src/transport/websocket.js'
import { WorkerTransportStore } from '../src/transport/transport-store.js'

async function until(check: () => boolean, timeoutMs = 2_000) { const deadline = Date.now() + timeoutMs; while (!check()) { if (Date.now() >= deadline) assert.fail(`Timed out: ${JSON.stringify(check())}`); await delay(5) } }
function acceptThenClose(server: WebSocketServer, onConnection: () => void) {
  server.on('connection', socket => {
    onConnection()
    socket.on('error', () => undefined)
    socket.once('message', raw => {
      const hello = JSON.parse(raw.toString())
      if (hello.frameType !== 'transport.hello') return socket.terminate()
      socket.send(JSON.stringify({ frameType: 'transport.hello', side: 'server', selectedTransport: { major: 2, minor: 0 }, selectedAdkProfile: 'wemux.adk.v1', features: ['durable-ack', 'bounded-replay'], logicalConnectionId: randomUUID(), serverInstanceId: randomUUID(), authoritativeCursors: { workerToServer: { deliveryEpoch: hello.resume.workerToServer.deliveryEpoch, ackThrough: 0 }, serverToWorker: { deliveryEpoch: randomUUID(), ackThrough: 0 } }, serverTime: new Date().toISOString() }))
      setTimeout(() => { try { socket.close(1000) } catch {} }, 50).unref()
    })
  })
}
async function closeServer(server: WebSocketServer) { for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())) }

function transport(url: string, changes: Array<{current:string;retryInMs?:number}>) {
  return new WebSocketTransport({ url, authToken: 'secret', workerId: randomUUID() as WorkerId, workerVersion: '1', name: 'w', platform: 'linux', architecture: 'x64', store: new WorkerTransportStore(':memory:'), onMessage: () => {}, onConnected: () => {}, onStateChange: change => changes.push(change), random: () => 0.5 })
}

test('quick connection flaps retain exponential retry state', async () => {
  const server = new WebSocketServer({ port: 0 }); await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address(); assert.ok(typeof address === 'object' && address)
  let connections = 0
  acceptThenClose(server, () => { connections += 1 })
  const changes: Array<{current:string;retryInMs?:number}> = [], client = transport(`ws://127.0.0.1:${address.port}`, changes)
  try {
    client.start(); await until(() => connections >= 1, 4_000); await delay(300); assert.ok(changes.some(change => change.current === 'backoff' && change.retryInMs === 1000), JSON.stringify(changes))
    await until(() => connections >= 2, 4_000); await delay(300); assert.ok(changes.some(change => change.current === 'backoff' && change.retryInMs === 2000), JSON.stringify(changes))
  } finally { client.stop(); await closeServer(server) }
})

test('stop cancels reconnect', async () => {
  const server = new WebSocketServer({ port: 0 }); await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address(); assert.ok(typeof address === 'object' && address)
  let connections = 0
  acceptThenClose(server, () => { connections += 1 })
  const changes: Array<{current:string}> = [], client = transport(`ws://127.0.0.1:${address.port}`, changes)
  try {
    client.start(); await until(() => connections >= 1, 4_000); await delay(300); assert.ok(changes.some(change => change.current === 'backoff'), JSON.stringify(changes))
    client.stop(); const stoppedAt = connections; await delay(1_100)
    assert.equal(connections, stoppedAt); assert.equal(changes.at(-1)?.current, 'stopped')
  } finally { client.stop(); await closeServer(server) }
})
