import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm',
}

// Vite's index contains two inline module-load error fallbacks. Hash those exact
// scripts rather than permitting arbitrary inline JavaScript in the Worker CSP.
function htmlScriptHashes(html: string): string {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter(match => match[1].trim())
    .map(match => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`)
    .join(' ')
}

export async function serveWorkerStatic(response: ServerResponse, pathname: string, accept: string | undefined, root: string): Promise<boolean> {
  if (response.writableEnded) return false
  const base = resolve(root)
  const wantsHtml = /(?:^|,)\s*text\/html(?:\s*;|\s*(?:,|$))/i.test(accept ?? '')
  let decoded: string
  try { decoded = decodeURIComponent(pathname) } catch { decoded = '' }
  if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\') || decoded === '/api' || decoded.startsWith('/api/')) decoded = ''
  const target = decoded === '/' ? resolve(base, 'index.html') : decoded ? resolve(base, '.' + decoded) : ''
  const inside = target && target !== base && target.startsWith(base + sep)
  let file = inside ? target : ''
  try {
    if (!file || !(await stat(file)).isFile()) file = ''
  } catch { file = '' }
  if (!file && wantsHtml && decoded && !decoded.includes('/assets/')) file = resolve(base, 'index.html')
  if (!file) return false
  let size: number
  try {
    if (!(await realpath(file)).startsWith((await realpath(base)) + sep)) return false
    const info = await stat(file)
    if (!info.isFile()) return false
    size = info.size
  } catch { return false }
  const html = extname(file).toLowerCase() === '.html'
  // Read only the entry point to derive exact hashes, avoiding a broad unsafe-inline policy.
  if (html) {
    const body = await readFile(file)
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' ${htmlScriptHashes(body.toString('utf8'))}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`)
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
    response.end(body)
  } else {
    response.writeHead(200, { 'Content-Type': contentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' })
    createReadStream(file).pipe(response)
  }
  return true
}
