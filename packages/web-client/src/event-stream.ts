import { ApiError } from './errors.ts'

/** Bound each frame, including ignored fields/comments. Payloads and IDs are never retained. */
const maxFrameCharacters = 1024 * 1024
export async function consumeEventStream(body: ReadableStream<Uint8Array>, onEvent: (event: string) => void, signal: AbortSignal): Promise<void> {
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let line = '', event = '', data = false, characters = 0, afterCR = false
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const finishLine = () => {
    if (line === '') {
      if (data) { signal.throwIfAborted(); onEvent(event || 'message') }
      event = ''; data = false; characters = 0
    } else if (!line.startsWith(':')) {
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') event = value
      if (field === 'data') data = true
    }
    line = ''
  }
  const consume = (text: string) => {
    for (const character of text) {
      signal.throwIfAborted()
      if (afterCR && character === '\n') { afterCR = false; continue }
      afterCR = false
      characters += character.length
      if (characters > maxFrameCharacters) throw new ApiError('事件流帧超过大小限制。', undefined, 'contract')
      if (character === '\r' || character === '\n') { finishLine(); afterCR = character === '\r' }
      else line += character
    }
  }
  const decode = (bytes?: Uint8Array) => {
    try { return decoder.decode(bytes, { stream: bytes !== undefined }) }
    catch { throw new ApiError('事件流不是有效的 UTF-8。', undefined, 'contract') }
  }
  try {
    signal.throwIfAborted()
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>
      try { result = await reader.read() }
      catch { signal.throwIfAborted(); throw new ApiError('事件流连接中断。', undefined, 'network') }
      signal.throwIfAborted()
      if (result.done) { consume(decode()); return } // An unterminated frame is not dispatched.
      for (let offset = 0; offset < result.value.length; offset += 4096) consume(decode(result.value.subarray(offset, offset + 4096)))
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
