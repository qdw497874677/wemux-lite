import { createHash } from 'node:crypto'
import type { Workspace } from '@wemux/server-domain'

/** Opaque STATE fingerprint, not a sequence number: equivalent state (ABA) has the same token.
 * Health derived from connectivity is excluded. Eligibility is checked independently in the write transaction. */
export function workspaceRevision(workspace: Workspace): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value
  return createHash('sha256').update(JSON.stringify(canonical({ id: workspace.id, projectId: workspace.projectId, name: workspace.name, spec: workspace.spec, deletedAt: workspace.deletedAt, placements: [...workspace.placements].sort((a, b) => a.workerId.localeCompare(b.workerId)) }))).digest('hex')
}
