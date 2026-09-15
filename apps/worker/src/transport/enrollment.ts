import type { WorkerId, Timestamp } from '@wemux/domain'
import type { WorkerIdentity } from '../domain/worker-identity.js'
import { serverUrl } from '../config.js'

/** HTTP enrollment seam; token is exchanged, never persisted or used on WebSocket. */
export async function enroll(input: { server: string; token: string; name: string; enrollmentPath: string; socketPath: string; candidates?: readonly string[]; identityServer?: string }): Promise<{ identity: WorkerIdentity; credential: string }> {
  const base = serverUrl(input.server)
  base.protocol = ['https:', 'wss:'].includes(base.protocol) ? 'https:' : 'http:'
  const endpoint = new URL(input.enrollmentPath, base)
  if (endpoint.origin !== base.origin) throw new Error('Enrollment endpoint must use Server origin')
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: input.token, name: input.name, workerVersion: '0.1.0', platform: process.platform, architecture: process.arch }) })
  if (!response.ok) throw new Error(`Enrollment failed (HTTP ${response.status})`)
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object' || !('workerId' in body) || typeof body.workerId !== 'string' || !body.workerId || !('credential' in body) || typeof body.credential !== 'string' || !body.credential || /[\r\n]/.test(body.credential)) throw new Error('Invalid enrollment response')
  // 身份地址永远保存原始候选（identityServer），而非 fetch 实际经过的隧道本地地址：
  // 隧道端口每次启动都会变，原始地址才是跨重启的稳定事实。
  const identityBase = input.identityServer ?? input.server
  const socket = toSocketUrl(identityBase, input.socketPath)
  const sockets = (input.candidates && input.candidates.length > 0 ? input.candidates : [identityBase]).map(candidate => toSocketUrl(candidate, input.socketPath).href)
  return { identity: { workerId: body.workerId as WorkerId, serverUrl: socket.href, serverUrls: sockets.length > 1 ? sockets : undefined, name: input.name, credentialRef: 'credential', enrolledAt: new Date().toISOString() as Timestamp }, credential: body.credential }
}

/** 把服务端地址归一化为 WebSocket 连接地址（https→wss、去掉路径尾巴、保留端口）。 */
export function toSocketUrl(server: string, socketPath: string): URL {
  const base = serverUrl(server)
  base.protocol = ['https:', 'wss:'].includes(base.protocol) ? 'https:' : 'http:'
  const socket = new URL(socketPath, base)
  if (socket.origin !== base.origin) throw new Error('Socket endpoint must use Server origin')
  socket.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  return socket
}
