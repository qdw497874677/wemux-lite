import { EventEmitter } from 'node:events'
import type { SessionId, WorkerId } from '@wemux/domain'

export interface NotificationFailure { readonly key: string; readonly error: unknown }
type Listener = () => void | Promise<void>
type ErrorReporter = (failure: NotificationFailure) => void | Promise<void>

/** In-process wakeups only; commands and events remain durable in the store. */
export class Notifications {
  private readonly emitter = new EventEmitter()
  constructor(private readonly reportError: ErrorReporter = failure => { console.error('Notification subscriber failed', failure) }) {
    this.emitter.setMaxListeners(0)
  }
  project(event: import('@wemux/web-contract/task-platform').ProjectEvent): void { this.emitter.emit(`project:${event.projectId}`, event) }
  onProject(projectId: string, listener: (event: import('@wemux/web-contract/task-platform').ProjectEvent) => void | Promise<void>): () => void {
    const key = `project:${projectId}`
    const isolated = (event: import('@wemux/web-contract/task-platform').ProjectEvent) => { try { void Promise.resolve(listener(event)).catch(error => this.failure(key, error)) } catch (error) { this.failure(key, error) } }
    this.emitter.on(key, isolated)
    return () => { this.emitter.off(key, isolated) }
  }
  commands(workerId: WorkerId): void { this.emitter.emit(`commands:${workerId}`) }
  session(sessionId: SessionId): void { this.emitter.emit(`session:${sessionId}`) }
  onCommands(workerId: WorkerId, listener: Listener): () => void { return this.subscribe(`commands:${workerId}`, listener) }
  onSession(sessionId: SessionId, listener: Listener): () => void { return this.subscribe(`session:${sessionId}`, listener) }
  private failure(key: string, error: unknown): void {
    // A broken diagnostics sink must not affect an already committed API either.
    try { void Promise.resolve(this.reportError({ key, error })).catch(() => undefined) } catch { /* isolated reporter */ }
  }
  private subscribe(key: string, listener: Listener): () => void {
    const isolated = () => {
      try { void Promise.resolve(listener()).catch(error => this.failure(key, error)) }
      catch (error) { this.failure(key, error) }
    }
    this.emitter.on(key, isolated)
    return () => { this.emitter.off(key, isolated) }
  }
}
