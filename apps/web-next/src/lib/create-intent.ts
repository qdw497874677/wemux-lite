import { useRef } from 'react'
import { randomId } from '@wemux/web-client'

/** An uncertain retry retains its identity; a successful submission starts a new intent. */
export function useCreateIntent() {
  const intent = useRef({ body: '', id: randomId() })
  return { id(body: unknown) { const encoded = JSON.stringify(body); if (intent.current.body !== encoded) intent.current = { body: encoded, id: randomId() }; return intent.current.id }, complete() { intent.current = { body: '', id: randomId() } } }
}
