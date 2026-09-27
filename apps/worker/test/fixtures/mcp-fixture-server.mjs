import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from 'node:http'
import { z } from 'zod'

const mode = process.env.MCP_FIXTURE_MODE ?? 'normal'
const startupDelay = Number(process.env.MCP_FIXTURE_STARTUP_DELAY_MS ?? 0)
if (startupDelay) await new Promise(resolve => setTimeout(resolve, startupDelay))

function configuredServer() {
  const server = new McpServer({ name: 'wemux-mcp-fixture', version: '1.0.0' })
  const count = mode === 'oversized' ? 5 : 1
  for (let index = 0; index < count; index += 1) {
    server.registerTool(index ? `extra_${index}` : 'echo', {
      description: 'Echo fixture input',
      inputSchema: { value: z.string().optional(), secret: z.string().optional(), delayMs: z.number().optional() },
      annotations: index ? undefined : { readOnlyHint: true },
    }, async ({ value = '', secret = '', delayMs = 0 }, extra) => {
      if (delayMs) await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs)
        extra.signal.addEventListener('abort', () => { clearTimeout(timer); reject(extra.signal.reason) }, { once: true })
      })
      if (mode === 'crash') process.exit(17)
      if (mode === 'huge-result') return { content: [{ type: 'text', text: 'x'.repeat(2_000_000) }] }
      return { content: [{ type: 'text', text: `${value}:${secret ? 'provided' : process.env.TEST_SECRET ? 'credential-loaded' : ''}` }] }
    })
  }
  return server
}

if (process.argv.includes('--http')) {
  const http = createServer(async (request, response) => {
    const server = configuredServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    response.on('close', () => { void transport.close(); void server.close() })
    await server.connect(transport)
    await transport.handleRequest(request, response)
  })
  await new Promise(resolve => http.listen(Number(process.env.PORT ?? 0), '127.0.0.1', resolve))
  const address = http.address()
  process.stdout.write(`${address.port}\n`)
  const close = () => http.close(() => process.exit(0))
  process.on('SIGTERM', close)
  process.on('SIGINT', close)
} else {
  const server = configuredServer()
  await server.connect(new StdioServerTransport())
}
