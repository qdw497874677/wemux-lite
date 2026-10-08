import type { ReviewPolicy, Run, TaskDetail, TaskReviewRequirementProjection } from '@wemux/web-contract/task-platform'

export const reviewPolicies: readonly ReviewPolicy[] = ['none', 'agent', 'human', 'multi-stage']

export function isReviewPolicy(value: unknown): value is ReviewPolicy {
  return typeof value === 'string' && (reviewPolicies as readonly string[]).includes(value)
}

/** One resolution shared by capability advertising (`taskFacts`), the launch pin and the query projection.
 *
 * `priorRuns` are the Runs that existed **before** the decision point (the launch path passes the Runs
 * saved so far minus the one it is creating). Order of rules, and nothing else:
 *  1. an explicit or previously pinned Task value wins and reports `frozen` as persisted;
 *  2. a Task that already executed without a pinned snapshot fails closed to `human` (`legacy`), because
 *     a record predating snapshots cannot prove which Project default applied at its first Run;
 *  3. otherwise the Project default applies (`none` when the Project has no policy either).
 * The projection never synthesizes a new requirement: it re-runs this rule on persisted state. */
export function resolveReviewRequirement(task: TaskDetail, priorRuns: readonly Run[], projectPolicy: ReviewPolicy | undefined): TaskReviewRequirementProjection {
  const values = task.metadataJson?.values ?? {}
  const pinned = values.reviewPolicy
  if (pinned !== undefined) return { policy: isReviewPolicy(pinned) ? pinned : 'human', source: 'task', frozen: values.reviewPolicyFrozen === true }
  if (priorRuns.length > 0) return { policy: 'human', source: 'legacy', frozen: false }
  return { policy: projectPolicy ?? 'none', source: 'project', frozen: false }
}