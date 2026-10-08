import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { extname, join, resolve, sep } from 'node:path'

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

export interface StaticSite { root: string }

const sendFile = async (response: ServerResponse, file: string): Promise<boolean> => {
  try {
    const stats = await stat(file)
    if (!stats.isFile()) return false
    const type = contentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream'
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': stats.size, 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' })
    await pipeline(createReadStream(file), response)
    return true
  } catch { return false }
}

/**
 * Serve a built web bundle: exact file matches first, then an index.html SPA
 * fallback for extensionless browser navigations (requests accepting text/html).
 * Missing assets and malformed URLs keep the handler's JSON 404, never HTML.
 */
export async function serveStaticSite(response: ServerResponse, requestPath: string, accept: string | undefined, site: StaticSite): Promise<boolean> {
  if (response.writableEnded) return false
  const root = resolve(site.root)
  let decoded: string
  try { decoded = requestPath === '/' ? '/index.html' : decodeURIComponent(requestPath) }
  catch { return false }
  const target = resolve(join(root, decoded.slice(1)))
  if ((target === root || target.startsWith(root + sep)) && await sendFile(response, target)) return true
  if (decoded === '/assets' || decoded.startsWith('/assets/') || extname(decoded)) return false
  if (!/text\/html/.test(accept ?? '')) return false
  return sendFile(response, join(root, 'index.html'))
}
