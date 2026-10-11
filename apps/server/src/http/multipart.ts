import { AppError } from '../application/errors.ts'

/**
 * Minimal binary-safe multipart/form-data parser for the coordination
 * attachment upload endpoint. The Server has no Web framework dependency, so
 * parsing stays local: parts are located with Buffer.indexOf over the raw
 * body, never over a lossy string conversion.
 */
export interface MultipartPart {
  readonly name: string
  readonly filename: string | null
  readonly contentType: string | null
  readonly data: Buffer
}

export function parseMultipart(body: Buffer, contentTypeHeader: string | null | undefined): MultipartPart[] {
  if (!contentTypeHeader?.toLowerCase().startsWith('multipart/form-data')) throw new AppError(400, 'Content-Type must be multipart/form-data', 'multipart_required')
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;,\s]+))/i.exec(contentTypeHeader)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
  if (!boundary) throw new AppError(400, 'Missing multipart boundary', 'multipart_required')
  const delimiter = Buffer.from(`--${boundary}`)
  const parts: MultipartPart[] = []
  let position = body.indexOf(delimiter)
  if (position < 0) throw new AppError(400, 'Malformed multipart body', 'multipart_required')
  position += delimiter.length
  for (;;) {
    // Terminator "--boundary--" ends the body; a part starts after CRLF.
    if (body.slice(position, position + 2).toString('latin1') === '--') break
    if (body.slice(position, position + 2).toString('latin1') !== '\r\n') throw new AppError(400, 'Malformed multipart body', 'multipart_required')
    position += 2
    const headerEnd = body.indexOf('\r\n\r\n', position)
    if (headerEnd < 0) throw new AppError(400, 'Malformed multipart part headers', 'multipart_required')
    const headerBlock = body.slice(position, headerEnd).toString('utf8')
    const next = body.indexOf(Buffer.from(`\r\n--${boundary}`), headerEnd + 4)
    if (next < 0) throw new AppError(400, 'Malformed multipart body', 'multipart_required')
    const data = body.slice(headerEnd + 4, next)
    const headers: Record<string, string> = {}
    for (const line of headerBlock.split('\r\n')) {
      const separator = line.indexOf(':')
      if (separator > 0) headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim()
    }
    const disposition = headers['content-disposition'] ?? ''
    const name = /name="([^"]*)"/i.exec(disposition)?.[1] ?? /name=([^;\s]+)/i.exec(disposition)?.[1]
    if (!name) throw new AppError(400, 'Malformed multipart part name', 'multipart_required')
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1] ?? (/filename=/i.test(disposition) ? '' : null)
    parts.push({ name, filename, contentType: headers['content-type'] ?? null, data })
    position = next + 2 + delimiter.length
  }
  return parts
}
