import { AesGcmSecretCodec, type ConnectorCredentialId, type CredentialRecord, type SecretCodec } from '@wemux/connector'
import type { WorkerConnectorStore } from './store.ts'

export class ConnectorCredentialError extends Error {
  readonly code: 'credential_unavailable' | 'invalid_input'

  constructor(code: 'credential_unavailable' | 'invalid_input', message: string) {
    super(message)
    this.code = code
  }
}

export type ConnectorCredentialSecret = Readonly<Record<string, string>>

export class WorkerCredentialStore {
  readonly available: boolean
  private readonly store: WorkerConnectorStore
  private readonly codec: SecretCodec | null

  constructor(store: WorkerConnectorStore, options: { readonly key?: string; readonly previousKeys?: readonly string[]; readonly codec?: SecretCodec } = {}) {
    this.store = store
    this.codec = options.codec ?? (options.key?.trim() ? new AesGcmSecretCodec({ currentKey: options.key, previousKeys: options.previousKeys }) : null)
    this.available = this.codec !== null
  }

  static fromEnvironment(store: WorkerConnectorStore, environment: NodeJS.ProcessEnv = process.env) {
    const key = environment.WEMUX_CONNECTOR_ENCRYPTION_KEY
    const previousKeys = environment.WEMUX_CONNECTOR_ENCRYPTION_PREVIOUS_KEYS?.split(',').map(value => value.trim()).filter(Boolean)
    return new WorkerCredentialStore(store, { key, previousKeys })
  }

  async put(input: {
    readonly id: ConnectorCredentialId
    readonly connectorId: string
    readonly authType: CredentialRecord['authType']
    readonly secret: ConnectorCredentialSecret
    readonly profile?: CredentialRecord['profile']
  }): Promise<CredentialRecord> {
    if (!this.codec) throw new ConnectorCredentialError('credential_unavailable', 'Connector credential encryption is unavailable')
    validateSecret(input.secret)
    const existing = await this.store.getConnectorCredential(input.id)
    if (existing && (existing.owner.kind !== 'connector' || existing.owner.connectorId !== input.connectorId)) throw new ConnectorCredentialError('invalid_input', 'Credential owner is immutable')
    const revision = (existing?.revision ?? 0) + 1
    const timestamp = new Date().toISOString() as import('@wemux/domain').Timestamp
    const context = { owner: { kind: 'connector' as const, id: input.connectorId }, credentialId: input.id, authType: input.authType, revision }
    const record: CredentialRecord = {
      id: input.id,
      owner: { kind: 'connector', connectorId: input.connectorId as import('@wemux/connector').ConnectorId },
      authType: input.authType,
      ciphertext: await this.codec.encode(JSON.stringify(input.secret), context),
      profile: input.profile ?? { accountId: null, displayName: null, grantedScopes: [] },
      revision,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }
    await this.store.saveConnectorCredential(record)
    return record
  }

  async resolve(id: ConnectorCredentialId, connectorId: string): Promise<{ readonly secret: ConnectorCredentialSecret; readonly revision: number }> {
    if (!this.codec) throw new ConnectorCredentialError('credential_unavailable', 'Connector credential encryption is unavailable')
    const record = await this.store.getConnectorCredential(id)
    if (!record || record.owner.kind !== 'connector' || record.owner.connectorId !== connectorId) throw new ConnectorCredentialError('credential_unavailable', 'Connector credential is not configured')
    try {
      const plaintext = await this.codec.decode(record.ciphertext, { owner: { kind: 'connector', id: connectorId }, credentialId: record.id, authType: record.authType, revision: record.revision })
      const parsed = JSON.parse(plaintext) as unknown
      validateSecret(parsed)
      return { secret: parsed, revision: record.revision }
    } catch (error) {
      if (error instanceof ConnectorCredentialError) throw error
      throw new ConnectorCredentialError('credential_unavailable', 'Connector credential could not be decrypted')
    }
  }
}

function validateSecret(value: unknown): asserts value is ConnectorCredentialSecret {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectorCredentialError('invalid_input', 'Credential secret must be an object')
  const entries = Object.entries(value)
  if (!entries.length || entries.length > 64 || entries.some(([name, secret]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || typeof secret !== 'string' || Buffer.byteLength(secret) > 64 * 1024)) {
    throw new ConnectorCredentialError('invalid_input', 'Credential secret contains invalid fields')
  }
}
