import type { TaskContentPatch, TaskMetadata, TaskPriority } from '@wemux/web-contract/task-platform'

import { parseTaskMetadata, sameTaskMetadata } from './task-metadata.ts'

const fields = ['title', 'description', 'acceptanceCriteria', 'priority', 'metadataJson'] as const
export type ContentField = typeof fields[number]
export type TaskContent = { title: string; description: string; acceptanceCriteria: string | null; priority: TaskPriority; metadataJson: TaskMetadata }
type ContentValues = Omit<TaskContent, 'metadataJson'> & { metadataJson: string }
const pick = (task: TaskContent): ContentValues => ({ title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria, priority: task.priority, metadataJson: JSON.stringify(task.metadataJson, null, 2) })
const same = (field: ContentField, left: ContentValues[ContentField], right: ContentValues[ContentField]) => field === 'metadataJson' ? sameTaskMetadata(left as string, right as string) : left === right
/** Audited from legacy TaskDraft: dirty-field patches and submitted-snapshot acknowledgement.
 * Field reconciliation is independent of the editor’s snapshot CAS. Choices persist across reads; null is not empty. */
export class TaskContentDraft {
  values: ContentValues
  private baseline: ContentValues
  private unresolved = new Set<ContentField>()
  constructor(task: TaskContent) { this.values = pick(task); this.baseline = pick(task) }
  get conflicts() { return fields.filter(field => this.unresolved.has(field)) }
  get dirty() { return fields.some(field => !same(field, this.values[field], this.baseline[field])) }
  remote(field: ContentField) { return this.baseline[field] }
  edit<K extends ContentField>(field: K, value: ContentValues[K]) {
    this.values = { ...this.values, [field]: value }
    if (same(field, value, this.baseline[field])) this.unresolved.delete(field)
  }
  receive(task: TaskContent) {
    const next = pick(task)
    for (const field of fields) {
      if (same(field, this.values[field], this.baseline[field])) this.values = { ...this.values, [field]: next[field] }
      else if (!same(field, next[field], this.baseline[field]) && !same(field, this.values[field], next[field])) this.unresolved.add(field)
      if (same(field, this.values[field], next[field])) this.unresolved.delete(field)
    }
    this.baseline = next
  }
  resolve(field: ContentField, choice: 'local' | 'remote') {
    if (choice === 'remote') this.values = { ...this.values, [field]: this.baseline[field] }
    this.unresolved.delete(field)
  }
  submission() {
    if (this.unresolved.size) throw Error('请先处理内容冲突。')
    return { snapshot: { ...this.values }, patch: Object.fromEntries(fields.filter(field => !same(field, this.values[field], this.baseline[field])).map(field => [field, field === 'metadataJson' ? parseTaskMetadata(this.values.metadataJson) : this.values[field]])) as TaskContentPatch }
  }
  saved(sent: ReturnType<TaskContentDraft['submission']>, task: TaskContent) {
    for (const field of fields) if (field in sent.patch) this.baseline = { ...this.baseline, [field]: sent.snapshot[field] }
    this.receive(task)
  }
}
