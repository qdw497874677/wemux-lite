import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export class CapabilityGateway {
  private readonly server = createServer((request, response) => void this.handle(request, response))
  private endpointValue: string | null = null

  constructor(private readonly serverUrl: string) {}

  get endpoint(): string {
    if (!this.endpointValue) throw new Error('Capability gateway is not listening')
    return this.endpointValue
  }

  async listen(): Promise<string> {
    if (this.endpointValue) return this.endpointValue
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve() })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Capability gateway has no TCP address')
    this.endpointValue = `http://127.0.0.1:${address.port}`
    return this.endpointValue
  }

  async close(): Promise<void> {
    if (!this.server.listening) return
    this.server.closeAllConnections()
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()))
    this.endpointValue = null
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    try {
      if (request.method !== 'POST') return reply(response, 404, { error: 'Not found' })
      const match = new URL(request.url ?? '/', 'http://localhost').pathname.match(/^\/([^/]+)$/)
      if (!match) return reply(response, 404, { error: 'Not found' })
      const authorization = request.headers.authorization
      if (!authorization?.startsWith('Bearer ')) return reply(response, 401, { error: 'Missing capability token' })
      const payload = await readBody(request)
      const upstream = await fetch(new URL(`/agent-capabilities/${encodeURIComponent(match[1])}`, httpOrigin(this.serverUrl)), {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: new Uint8Array(payload),
      })
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' })
      response.end(Buffer.from(await upstream.arrayBuffer()))
    } catch (error) {
      reply(response, 502, { error: error instanceof Error ? error.message : 'Capability gateway failed' })
    }
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    length += buffer.length
    if (length > 1024 * 1024) throw new Error('Request too large')
    chunks.push(buffer)
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.from('{}')
}

export function httpOrigin(serverUrl: string): string {
  const url = new URL(serverUrl)
  if (url.protocol === 'ws:') url.protocol = 'http:'
  else if (url.protocol === 'wss:') url.protocol = 'https:'
  else if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Unsupported server URL protocol: ${url.protocol}`)
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function reply(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}
