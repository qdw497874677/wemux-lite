import { createHash } from 'node:crypto'
import type { SessionHistoryGateStore } from '../storage/session-history-gate-store.ts'

// Provisional, private root-only fixture types. None of these values authenticate a remote caller.
export interface HistoryScope {
  authority: string
  workerId: string
  storeId: string
  sessionId: string
  binding: string
  recoveryEpoch: string
}
export interface RootAdmission {
  scope: HistoryScope
  id: string
  generation: number
  sequence: number
  kind: string
  coverage: string
  fingerprint: string
}
export interface PrepareManifest {
  scope: HistoryScope
  barrierId: string
  generation: number
  revision: number
  cutoff: number
  admissions: RootAdmission[]
  digest: string
}
export interface ReleaseManifest extends PrepareManifest {
  prepareRevision: number
  newGeneration: number
}
export type Rejection = { status: 'reject'; reason: string }
export type ControlResult = { status: 'accepted' | 'unchanged' } | Rejection
export type ReservationResult = { status: 'execute' | 'awaitExisting' | 'unknown' } | { status: 'replay'; result: Uint8Array } | Rejection
export interface AdmissionRecord {
  identity: RootAdmission
  state: 'admitted' | 'reserved' | 'settled' | 'unknown'
  resultBase64?: string
}
export interface HistoryGateState {
  scope: HistoryScope
  generation: number
  mode: 'open' | 'prepared'
  revision: number
  admissions: AdmissionRecord[]
  controls: { prepare: PrepareManifest; release?: ReleaseManifest }[]
}

const scopeKey = (scope: HistoryScope) => JSON.stringify([
  scope.authority, scope.workerId, scope.storeId, scope.sessionId, scope.binding, scope.recoveryEpoch,
])
const identityKey = (identity: RootAdmission) => JSON.stringify([
  scopeKey(identity.scope), identity.id, identity.generation, identity.sequence,
  identity.kind, identity.coverage, identity.fingerprint,
])
const positive = (value: number) => Number.isSafeInteger(value) && value > 0
const reject = (reason: string): Rejection => ({ status: 'reject', reason })
const sameIdentity = (a: RootAdmission, b: RootAdmission) => identityKey(a) === identityKey(b)
const validScope = (scope: HistoryScope) => [scope.authority, scope.workerId, scope.storeId, scope.sessionId, scope.binding, scope.recoveryEpoch]
  .every(value => typeof value === 'string' && value.length > 0)

/** Integrity check for trusted test manifests only, not a signature or a completeness proof. */
export function historyManifestDigest(manifest: Omit<PrepareManifest, 'digest'> | Omit<ReleaseManifest, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify([
    scopeKey(manifest.scope), manifest.barrierId, manifest.generation, manifest.revision, manifest.cutoff,
    manifest.admissions.map(identityKey).sort(),
    'prepareRevision' in manifest ? [manifest.prepareRevision, manifest.newGeneration] : null,
  ])).digest('hex')
}

/** Explicitly constructed private gate; never installed into Worker startup or effect scheduling. */
export class SessionHistoryGate {
  constructor(private readonly store: SessionHistoryGateStore, scope: HistoryScope) {
    if (!validScope(scope)) throw new Error('Invalid private history scope')
    store.initialize({ scope, generation: 1, mode: 'open', revision: 0, admissions: [], controls: [] })
    if (scopeKey(this.inspect().scope) !== scopeKey(scope)) throw new Error('Private history scope mismatch')
  }

  private validateIdentity(state: HistoryGateState, identity: RootAdmission): Rejection | undefined {
    if (scopeKey(identity.scope) !== scopeKey(state.scope)) return reject('scope mismatch')
    if (identity.kind !== 'fs.write' || identity.coverage !== 'root-only') return reject('ineligible coverage')
    if (!identity.id || !positive(identity.generation) || !positive(identity.sequence) || !/^[a-f0-9]{64}$/.test(identity.fingerprint)) return reject('invalid identity')
    const existing = state.admissions.find(item => item.identity.id === identity.id)
    if (existing && !sameIdentity(existing.identity, identity)) return reject('identity conflict')
    if (state.admissions.some(item => item.identity.id !== identity.id && item.identity.generation === identity.generation && item.identity.sequence === identity.sequence)) return reject('sequence conflict')
  }

  recordAdmission(identity: RootAdmission): ControlResult {
    return this.store.transaction(state => {
      const invalid = this.validateIdentity(state, identity)
      if (invalid) return invalid
      if (state.admissions.some(item => item.identity.id === identity.id)) return { status: 'unchanged' }
      if (state.mode !== 'open' || identity.generation !== state.generation) return reject('admissions closed for generation')
      state.admissions.push({ identity, state: 'admitted' })
      return { status: 'accepted' }
    })
  }

  private validateManifest(state: HistoryGateState, manifest: PrepareManifest): Rejection | undefined {
    if (scopeKey(manifest.scope) !== scopeKey(state.scope)) return reject('scope mismatch')
    if (!manifest.barrierId || !positive(manifest.generation) || !positive(manifest.revision) || !Number.isSafeInteger(manifest.cutoff) || manifest.cutoff < 0) return reject('invalid control')
    if (historyManifestDigest(manifest) !== manifest.digest) return reject('manifest digest mismatch')
    const ids = new Set<string>()
    const sequences = new Set<string>()
    for (const identity of manifest.admissions) {
      const invalid = this.validateIdentity(state, identity)
      if (invalid) return invalid
      const sequence = `${identity.generation}:${identity.sequence}`
      if (ids.has(identity.id) || sequences.has(sequence)) return reject('duplicate manifest entry')
      ids.add(identity.id)
      sequences.add(sequence)
      if (identity.generation > manifest.generation || (identity.generation === manifest.generation && identity.sequence > manifest.cutoff)) return reject('outside cutoff')
    }
  }

  private validateCompleteLocalHistory(state: HistoryGateState, manifest: PrepareManifest): Rejection | undefined {
    if (state.admissions.some(item => !manifest.admissions.some(identity => sameIdentity(identity, item.identity)))) return reject('manifest omits local admission')
  }

  private importAdmissions(state: HistoryGateState, manifest: PrepareManifest): void {
    for (const identity of manifest.admissions) {
      if (!state.admissions.some(item => item.identity.id === identity.id)) state.admissions.push({ identity, state: 'admitted' })
    }
  }

  prepare(manifest: PrepareManifest): ControlResult {
    return this.store.transaction(state => {
      // A release shape is not a prepare control, even with a valid release digest.
      if ('prepareRevision' in manifest || 'newGeneration' in manifest) return reject('wrong control kind')
      const invalid = this.validateManifest(state, manifest)
      if (invalid) return invalid
      const prior = state.controls.find(item => item.prepare.barrierId === manifest.barrierId)
      if (prior) return prior.prepare.digest === manifest.digest ? { status: 'unchanged' } : reject('barrier conflict')
      if (state.mode !== 'open' || manifest.generation !== state.generation || manifest.revision <= state.revision) return reject('stale or conflicting prepare')
      const incomplete = this.validateCompleteLocalHistory(state, manifest)
      if (incomplete) return incomplete
      this.importAdmissions(state, manifest)
      state.controls.push({ prepare: manifest })
      state.mode = 'prepared'
      state.revision = manifest.revision
      return { status: 'accepted' }
    })
  }

  release(manifest: ReleaseManifest): ControlResult {
    return this.store.transaction(state => {
      const invalid = this.validateManifest(state, manifest)
      if (invalid) return invalid
      if (!positive(manifest.prepareRevision) || manifest.revision <= manifest.prepareRevision || manifest.newGeneration !== manifest.generation + 1 || !positive(manifest.newGeneration)) return reject('invalid release generation or revision')
      const prepare: PrepareManifest = {
        scope: manifest.scope, barrierId: manifest.barrierId, generation: manifest.generation,
        revision: manifest.prepareRevision, cutoff: manifest.cutoff, admissions: manifest.admissions, digest: '',
      }
      prepare.digest = historyManifestDigest(prepare)
      const prior = state.controls.find(item => item.prepare.barrierId === manifest.barrierId)
      if (prior?.release) return prior.release.digest === manifest.digest ? { status: 'unchanged' } : reject('release conflict')
      if (prior && prior.prepare.digest !== prepare.digest) return reject('prepare frontier conflict')
      if (manifest.generation !== state.generation || manifest.revision <= state.revision) return reject('stale release')
      if (!prior && (state.mode !== 'open' || manifest.prepareRevision <= state.revision)) return reject('conflicting release')
      const incomplete = this.validateCompleteLocalHistory(state, manifest)
      if (incomplete) return incomplete
      this.importAdmissions(state, manifest)
      if (prior) prior.release = manifest
      else state.controls.push({ prepare, release: manifest })
      state.generation = manifest.newGeneration
      state.revision = manifest.revision
      state.mode = 'open'
      return { status: 'accepted' }
    })
  }

  reserveEffect(identity: RootAdmission): ReservationResult {
    return this.store.transaction(state => {
      const invalid = this.validateIdentity(state, identity)
      if (invalid) return invalid
      const record = state.admissions.find(item => item.identity.id === identity.id)
      if (!record) return reject('not admitted')
      if (record.state === 'reserved') return { status: 'awaitExisting' }
      if (record.state === 'unknown') return { status: 'unknown' }
      if (record.state === 'settled') return { status: 'replay', result: Buffer.from(record.resultBase64!, 'base64') }
      // Conservative private exclusion, not a production Workspace/Session scheduler.
      if (state.admissions.some(item => item.state === 'reserved' || item.state === 'unknown')) return reject('unresolved effect excludes execution')
      record.state = 'reserved'
      return { status: 'execute' }
    })
  }

  settleEffect(identity: RootAdmission, result: Uint8Array): ControlResult {
    return this.store.transaction(state => {
      const invalid = this.validateIdentity(state, identity)
      if (invalid) return invalid
      const record = state.admissions.find(item => item.identity.id === identity.id)
      const bytes = Buffer.from(result).toString('base64')
      if (record?.state === 'settled') return record.resultBase64 === bytes ? { status: 'unchanged' } : reject('result conflict')
      if (record?.state !== 'reserved') return reject('no live reservation')
      record.state = 'settled'
      record.resultBase64 = bytes
      return { status: 'accepted' }
    })
  }

  markUnknown(identity: RootAdmission): ControlResult {
    return this.store.transaction(state => {
      const invalid = this.validateIdentity(state, identity)
      if (invalid) return invalid
      const record = state.admissions.find(item => item.identity.id === identity.id)
      if (record?.state === 'unknown') return { status: 'unchanged' }
      if (record?.state !== 'reserved') return reject('no live reservation')
      record.state = 'unknown'
      return { status: 'accepted' }
    })
  }

  inspect(): HistoryGateState & { localSubsetSettled: boolean } {
    return this.store.transaction(state => ({
      ...structuredClone(state),
      // Not proof eligibility: no remote completeness, authorization or Agent coverage exists here.
      localSubsetSettled: state.mode === 'prepared' && state.admissions.every(item => item.state === 'settled'),
    }))
  }
}
