import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { authorizationBytes, type EnqueueAuthorization, type SignedEnqueueAuthorization } from '@wemux/wire-protocol/command-assertion'

/** Instance identity stored in the primary database, not a per-boot capability secret. */
export class CommandSigningIdentity {
  readonly publicKey: string
  readonly keyId: string
  private readonly privateKey: string
  constructor(db: DatabaseSync) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare("SELECT data FROM records WHERE kind='command-signing' AND id='instance'").get()
      if (row) {
        const saved = JSON.parse(String(row.data)) as { publicKey: string; privateKey: string }
        this.publicKey = saved.publicKey; this.privateKey = saved.privateKey
      } else {
        const keys = generateKeyPairSync('ed25519')
        this.publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
        this.privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
        db.prepare("INSERT INTO records(kind,id,data) VALUES('command-signing','instance',?)").run(JSON.stringify({ publicKey: this.publicKey, privateKey: this.privateKey }))
      }
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    this.keyId = createHash('sha256').update(this.publicKey).digest('hex')
  }
  sign(claims: EnqueueAuthorization): SignedEnqueueAuthorization {
    if (claims.keyId !== this.keyId) throw new Error('Signing key mismatch')
    return { claims, signature: sign(null, authorizationBytes(claims), this.privateKey).toString('base64url') }
  }
}
