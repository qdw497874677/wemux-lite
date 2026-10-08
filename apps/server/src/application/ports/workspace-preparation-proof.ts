import type { WorkerId, WorkspaceId } from '@wemux/domain'

/** Internal evidence of an authenticated, correlated terminal preparation report.
 * Not command acceptance, physical cleanup, or deletion eligibility. Callers must
 * validate current-attempt ownership before recording; delayed superseded reports
 * are not admitted. Kept outside Workspace and its state-equivalence revision.
 */
export interface WorkspacePreparationProofIdentity {
  readonly workspaceId: WorkspaceId
  readonly workerId: WorkerId
  readonly commandId: string
}

export interface WorkspacePreparationProof extends WorkspacePreparationProofIdentity {
  readonly status: 'ready' | 'failed'
  /** First validated terminal observation; repeated observations never replace it. */
  readonly occurredAt: string
}
