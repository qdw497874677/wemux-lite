import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import type { FileRequestPayload, TerminalRequestPayload } from '@wemux/wire-protocol'
import { adminRouteFixture } from './admin-route-fixture.ts'
import { TransportV2Peer } from '../transport-v2-peer.ts'

export const sessionEffects = [
  { path: '/fs/write', body: { subpath: 'fixture.txt', base64Content: 'YQ==' }, status: 200 },
  { path: '/terminal', body: { cols: 80, rows: 24 }, status: 201 },
  { path: '/terminal/synthetic-terminal/write', body: { data: 'synthetic input' }, status: 200 },
  { path: '/terminal/synthetic-terminal/resize', body: { cols: 90, rows: 30 }, status: 200 },
  { path: '/terminal/synthetic-terminal/dispose', body: {}, status: 200 },
] as const

/** Deterministic gateway peer, not a Worker runtime: no files, shells or Agent execution. */
export function effectResponse(payload: FileRequestPayload | TerminalRequestPayload) {
  const base = { requestId: payload.requestId, ok: true, operation: payload.operation }
  if (payload.type === 'terminal.request') return { ...base, type: 'terminal.response', ...(payload.operation === 'create' ? { terminalId: 'synthetic-terminal', pid: 1 } : {}) }
  switch (payload.operation) {
    case 'write': return { ...base, type: 'fs.response', subpath: payload.subpath, size: 1 }
    case 'list': return { ...base, type: 'fs.response', entries: [] }
    case 'read': return { ...base, type: 'fs.response', content: 'a', size: 1, truncated: false, binary: false }
    case 'diff': return { ...base, type: 'fs.response', supported: true, lines: [] }
  }
}

export async function sessionEffectFixture(webNextStaticPath?: string) {
  const f = await adminRouteFixture(webNextStaticPath)
  let peer: TransportV2Peer | undefined
  try {
    const socket = new WebSocket(`${f.origin.replace('http', 'ws')}/worker/ws`, { headers: { authorization: `Bearer ${f.worker.credential}` } })
    peer = new TransportV2Peer(socket, f.worker.workerId)
    const effects: (FileRequestPayload | TerminalRequestPayload)[] = []
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString())
      if (frame.frameType !== 'data' || !['fs.request', 'terminal.request'].includes(frame.payload.type)) return
      effects.push(frame.payload)
      peer!.send(effectResponse(frame.payload))
    })
    await peer.connect({ name: 'Controlled effect gateway' })
    return { ...f, effects,
      async role(role: 'viewer' | 'contributor' | 'manager') {
        assert.equal((await f.request(`/projects/${f.project.id}/grants`, { body: { userId: f.accounts.member.id, role } })).status, 201)
      },
      async scope(shareScope: 'owner-only' | 'project' | 'selected-members') {
        assert.equal((await f.request(`/sessions/${f.sessionId}/access`, { method: 'PATCH', body: { shareScope } })).status, 200)
      },
      async close() { try { await peer!.close() } finally { await f.close() } },
    }
  } catch (error) { try { await peer?.close() } finally { await f.close() }; throw error }
}
