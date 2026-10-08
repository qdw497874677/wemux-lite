import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Each invocation owns only its mkdtemp directory, including on assertion failure.
export async function withRealAppAbortEvidence(run) {
  const evidence = await mkdtemp(join(tmpdir(), 'wemux-real-app-abort-test-'))
  try { return await run(evidence) }
  finally { await rm(evidence, { recursive: true, force: true }) }
}
