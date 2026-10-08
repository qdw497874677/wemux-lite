/** Memory-only pending identities, scoped by caller + Workspace + Worker tuple.
 * Acknowledging B (or an older A) cannot clear an uncertain A. */
export class PlacementRetryIntents {
  private pending = new Map<string, string>()
  private readonly nextId: () => string
  constructor(nextId: () => string) { this.nextId = nextId }
  id(scope: readonly string[]) {
    const key = JSON.stringify(scope)
    let id = this.pending.get(key)
    if (!id) { id = this.nextId(); this.pending.set(key, id) }
    return id
  }
  acknowledge(scope: readonly string[], requestId: string) {
    const key = JSON.stringify(scope)
    if (this.pending.get(key) === requestId) this.pending.delete(key)
  }
}
