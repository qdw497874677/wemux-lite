import type { DatabaseSync } from 'node:sqlite'
import { serializeFileWriteRetainedResult, type FileWriteAdmitPayload, type FileWriteResultPayload } from '@wemux/wire-protocol'
import { computeFileWriteResultDigest, parseFileWriteAdmit, parseFileWriteResult, parseFileWriteResultAck } from '@wemux/wire-protocol/file-admission-node'
import type { WorkerFileWriteReader, WorkerFileWriteWriter } from '../application/ports/worker-store-types.js'
import type { WorkerFileWriteRecord } from '../domain/file-write-admission.js'

function admissionSnapshot(value: FileWriteAdmitPayload): FileWriteAdmitPayload {
  const item = parseFileWriteAdmit(structuredClone(value))
  return Object.freeze({
    type: item.type, requestId: item.requestId, actorId: item.actorId,
    sessionId: item.sessionId, clientRequestId: item.clientRequestId,
    operation: item.operation, workerId: item.workerId,
    binding: Object.freeze({ workspaceId: item.binding.workspaceId,
      agent: Object.freeze({ workerId: item.binding.agent.workerId, agentKey: item.binding.agent.agentKey }),
      modelId: item.binding.modelId }),
    subpath: item.subpath, base64Content: item.base64Content,
    fingerprintVersion: item.fingerprintVersion, fingerprint: item.fingerprint,
  })
}

function resultSnapshot(value: FileWriteResultPayload, admission: FileWriteAdmitPayload): FileWriteResultPayload {
  const item = parseFileWriteResult(structuredClone(value), admission)
  return Object.freeze({
    type: item.type, requestId: item.requestId, sessionId: item.sessionId,
    workerId: item.workerId, operation: item.operation,
    fingerprintVersion: item.fingerprintVersion, fingerprint: item.fingerprint,
    resultVersion: item.resultVersion, outcome: item.outcome,
    resultJson: item.resultJson, resultDigest: item.resultDigest,
  })
}

/** Synchronous SQL only: the owning WorkerStore supplies the FIFO and transaction lease. */
export function fileWriteStorage(db: DatabaseSync) {
  const get = (requestId: string): WorkerFileWriteRecord | null => {
    const row = db.prepare(`SELECT a.admission_json, r.result_json, d.acknowledged
      FROM worker_file_admissions a LEFT JOIN worker_file_results r USING(request_id)
      LEFT JOIN worker_file_result_delivery d USING(request_id) WHERE a.request_id=?`).get(requestId)
    if (!row) return null
    const admission = admissionSnapshot(JSON.parse(String(row.admission_json)))
    const result = row.result_json === null ? null : resultSnapshot(JSON.parse(String(row.result_json)), admission)
    if (result && row.acknowledged === null) throw new Error('File result delivery missing')
    return Object.freeze({ admission, result, acknowledged: row.acknowledged === 1 })
  }
  const retain = (input: FileWriteResultPayload): void => {
    const snapshot = structuredClone(input)
    const record = get(snapshot.requestId)
    if (!record) throw new Error('File admission not found')
    const result = resultSnapshot(snapshot, record.admission)
    if (record.result) {
      if (JSON.stringify(record.result) !== JSON.stringify(result)) throw new Error('File result conflict')
      return
    }
    // Trigger-created delivery and a savepoint also cover SQLite FAIL errors,
    // which otherwise preserve earlier changes in the same statement when caught.
    db.exec('SAVEPOINT worker_file_retain')
    try {
      db.prepare('INSERT INTO worker_file_results(request_id,result_json) VALUES(?,?)').run(result.requestId, JSON.stringify(result))
      db.exec('RELEASE worker_file_retain')
    } catch (error) {
      db.exec('ROLLBACK TO worker_file_retain; RELEASE worker_file_retain')
      throw error
    }
  }
  const reader: WorkerFileWriteReader = {
    get: async requestId => get(requestId),
    listPendingResults: async limit => {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid pending result limit')
      return db.prepare('SELECT request_id FROM worker_file_result_delivery WHERE acknowledged=0 ORDER BY rowid LIMIT ?')
        .all(limit).map(row => get(String(row.request_id))!.result!)
    },
  }
  const writer = (assertActive: () => void): WorkerFileWriteWriter => ({
    reserve: async input => {
      assertActive()
      const admission = admissionSnapshot(input)
      const record = get(admission.requestId)
      if (record) {
        if (JSON.stringify(record.admission) !== JSON.stringify(admission)) return { status: 'reject', reason: 'identity-conflict' }
        if (record.result) return { status: record.result.outcome === 'unknown' ? 'unknown' : 'replay', result: record.result }
        return { status: 'await-existing', admission: record.admission }
      }
      db.prepare('INSERT INTO worker_file_admissions(request_id,admission_json) VALUES(?,?)').run(admission.requestId, JSON.stringify(admission))
      return { status: 'execute', admission }
    },
    retainResult: async input => { assertActive(); retain(input) },
    acknowledgeResult: async input => {
      assertActive()
      const snapshot = structuredClone(input)
      const record = get(snapshot.requestId)
      if (!record?.result) throw new Error('File result not found')
      parseFileWriteResultAck(snapshot, record.result)
      db.prepare('UPDATE worker_file_result_delivery SET acknowledged=1 WHERE request_id=?').run(snapshot.requestId)
    },
    recoverUnresolved: async () => {
      assertActive()
      // All unresolved rows form one recovery operation, including when its error
      // is caught by the enclosing transaction callback.
      db.exec('SAVEPOINT worker_file_recovery')
      try {
        const rows = db.prepare(`SELECT a.request_id FROM worker_file_admissions a
          LEFT JOIN worker_file_results r USING(request_id) WHERE r.request_id IS NULL ORDER BY a.rowid`).all()
        for (const row of rows) {
          const admission = get(String(row.request_id))!.admission
          const result: Omit<FileWriteResultPayload, 'resultDigest'> = {
            type: 'fs.write.result', requestId: admission.requestId, sessionId: admission.sessionId,
            workerId: admission.workerId, operation: admission.operation,
            fingerprintVersion: admission.fingerprintVersion, fingerprint: admission.fingerprint,
            resultVersion: 1, outcome: 'unknown',
            resultJson: serializeFileWriteRetainedResult('unknown', { ok: false, operation: 'write', effect: 'uncertain', error: 'Unresolved reservation recovered by exclusive runtime owner' }),
          }
          retain({ ...result, resultDigest: computeFileWriteResultDigest(result) })
        }
        db.exec('RELEASE worker_file_recovery')
        return rows.length
      } catch (error) {
        db.exec('ROLLBACK TO worker_file_recovery; RELEASE worker_file_recovery')
        throw error
      }
    },
  })
  return { reader, writer }
}
