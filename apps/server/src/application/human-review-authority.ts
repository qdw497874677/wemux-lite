import type { ProjectGrantRole } from '@wemux/server-domain'

/** Project ownership is independent of membership; a manager grant is not. */
export function canDecideHumanReview(actor: string, submitter: string, ownerId: string, hasMembership: boolean, projectRole: ProjectGrantRole | undefined): boolean {
  return actor !== submitter && (actor === ownerId || (hasMembership && projectRole === 'manager'))
}
