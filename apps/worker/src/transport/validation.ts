import { parseServerTransportFrame, type ServerPayload } from '@wemux/wire-protocol'

/** Parse a pure transport-v2 Server data frame and return its application payload. */
export function parseServerMessage(raw: string): ServerPayload {
  const frame = parseServerTransportFrame(JSON.parse(raw))
  if (frame.frameType !== 'data') throw new Error('Expected transport v2 data frame')
  return frame.payload
}
