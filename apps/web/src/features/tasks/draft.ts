import type { TaskContentPatch, TaskDetail } from '@wemux/web-contract/task-platform'

const fields = ['title', 'description', 'acceptanceCriteria', 'priority', 'metadataJson'] as const
type Field = typeof fields[number]
export type TaskFields = Record<Field, string>
export function taskFields(task?: TaskDetail): TaskFields {
  return { title: task?.title ?? '', description: task?.description ?? '', acceptanceCriteria: task?.acceptanceCriteria ?? '', priority: task?.priority ?? 'none', metadataJson: JSON.stringify(task?.metadataJson ?? { schemaVersion: 1, values: {} }, null, 2) }
}
/** Content has no CAS version. Compare each field against the last server snapshot. */
export class TaskDraft {
  values: TaskFields
  private baseline: TaskFields
  private editRevision = 0
  get revision() { return this.editRevision }
  remoteChanged = false
  constructor(task?: TaskDetail) { this.values = taskFields(task); this.baseline = { ...this.values } }
  get dirty() { return fields.some(key => this.values[key] !== this.baseline[key]) }
  edit(key: Field, value: string) { this.editRevision++; this.values = { ...this.values, [key]: value } }
  receive(task: TaskDetail) {
    const next = taskFields(task)
    if (this.dirty && fields.some(key => next[key] !== this.baseline[key])) this.remoteChanged = true
    for (const key of fields) {
      if (next[key] === this.baseline[key]) continue
      if (this.values[key] === this.baseline[key]) this.values[key] = next[key]
      else if (this.values[key] !== next[key]) this.remoteChanged = true
    }
    this.baseline = next
  }
  reload(task: TaskDetail, revision: number) {
    // Confirmation only covers edits made before GET began, including edit-then-revert.
    if (revision !== this.editRevision) return false
    this.values = taskFields(task); this.baseline = { ...this.values }; this.remoteChanged = false
    return true
  }
  submission(create = false) {
    const snapshot = { ...this.values }
    const patch = Object.fromEntries(fields.filter(key => create || snapshot[key] !== this.baseline[key]).map(key => [key, key === 'metadataJson' ? JSON.parse(snapshot[key]) : snapshot[key]])) as TaskContentPatch
    return { snapshot, patch }
  }
  saved(snapshot: TaskFields, patch: TaskContentPatch, task?: TaskDetail) {
    // Only acknowledge the submitted snapshot, never edits typed while PATCH was pending.
    for (const key of fields) if (key in patch) this.baseline[key] = snapshot[key]
    if (task) this.receive(task)
    if (!this.dirty) this.remoteChanged = false
  }
}
