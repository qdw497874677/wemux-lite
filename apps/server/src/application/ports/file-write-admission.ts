import type { SessionBinding, SessionId, Timestamp, UserId, WorkerId } from '@wemux/domain'

export interface FileWriteKey {
  readonly actorId: UserId
  readonly sessionId: SessionId
  readonly requestId: string
}

/** Immutable Server admission only: not evidence of dispatch or a filesystem effect. */
export interface FileWriteAdmission extends FileWriteKey {
  readonly admissionId: string
  readonly operation: 'fs.write'
  readonly workerId: WorkerId
  readonly binding: SessionBinding
  readonly subpath: string
  readonly base64Content: string
  readonly fingerprintVersion: 1
  readonly fingerprint: string
  readonly admittedAt: Timestamp
}

/** Held is never deliverable; historical result retention does not change this intent. */
export interface HeldFileWriteIntent {
  readonly admissionId: string
  readonly state: 'held'
}

export interface FileWriteReader {
  find(key: FileWriteKey): Promise<FileWriteAdmission | null>
  get(admissionId: string): Promise<FileWriteAdmission | null>
  getIntent(admissionId: string): Promise<HeldFileWriteIntent | null>
  /** Internal committed observation, not a browser-authorized result read. */
  getResult(admissionId: string): Promise<import('@wemux/wire-protocol').FileWriteResultPayload | null>
}

export interface FileWriteWriter {
  /** Insert-only admission and held intent; caller owns the authorization transaction. */
  insertHeld(admission: FileWriteAdmission): Promise<void>
  /** Trusted caller supplies authenticated Worker identity. Return is provisional until commit. */
  retainResult(authenticatedWorkerId: WorkerId, input: unknown): Promise<import('@wemux/wire-protocol').FileWriteResultPayload>
}
