import { AesGcmSecretCodec, type SecretCodec } from '@wemux/connector'

export interface ProviderCredentialRecord {
  readonly id: string
  readonly variableNames: readonly string[]
  readonly ciphertext: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ProviderCredentialRepository {
  getProviderCredential(id: string): Promise<ProviderCredentialRecord | null>
  saveProviderCredential(record: ProviderCredentialRecord, expectedRevision: number): Promise<boolean>
  deleteProviderCredential(id: string, expectedRevision: number): Promise<boolean>
  listProviderCredentials(): Promise<readonly ProviderCredentialRecord[]>
}

export class ProviderCredentialError extends Error {
  constructor(readonly code: 'invalid_input' | 'credential_unavailable' | 'revision_conflict', message: string) { super(message) }
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const providerEnvironmentNames = new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'AZURE_OPENAI_API_KEY'])

function validateNames(names: unknown): asserts names is string[] {
  if (!Array.isArray(names) || !names.length || names.length > 4 || names.some(name => typeof name !== 'string' || !providerEnvironmentNames.has(name)) || new Set(names).size !== names.length) {
    throw new ProviderCredentialError('invalid_input', '模型凭据字段无效')
  }
}

function validateSecret(value: unknown, names: readonly string[]): asserts value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name) || typeof (value as Record<string, unknown>)[name] !== 'string' || !(value as Record<string, string>)[name]?.trim() || Buffer.byteLength((value as Record<string, string>)[name]!) > 64 * 1024)) {
    throw new ProviderCredentialError('invalid_input', '模型凭据字段必须与声明的环境变量一致')
  }
}

const context = (id: string, revision: number) => ({ owner: { kind: 'model-provider' as const, id }, credentialId: id, authType: 'api_key' as const, revision })

export class WorkerProviderCredentialStore {
  readonly available: boolean
  private readonly codec: SecretCodec | null

  constructor(private readonly repository: ProviderCredentialRepository, options: { readonly key?: string; readonly previousKeys?: readonly string[]; readonly codec?: SecretCodec } = {}) {
    this.codec = options.codec ?? (options.key?.trim() ? new AesGcmSecretCodec({ currentKey: options.key, previousKeys: options.previousKeys }) : null)
    if (this.codec && !this.codec.encrypted) throw new ProviderCredentialError('credential_unavailable', '模型凭据必须加密存储')
    this.available = this.codec !== null
  }

  static fromEnvironment(repository: ProviderCredentialRepository, environment: NodeJS.ProcessEnv = process.env) {
    return new WorkerProviderCredentialStore(repository, {
      key: environment.WEMUX_CONNECTOR_ENCRYPTION_KEY,
      previousKeys: environment.WEMUX_CONNECTOR_ENCRYPTION_PREVIOUS_KEYS?.split(',').map(key => key.trim()).filter(Boolean),
    })
  }

  async list(): Promise<readonly { id: string; variableNames: readonly string[]; revision: number; availability: 'available' | 'unavailable' }[]> {
    const records = await this.repository.listProviderCredentials()
    return Promise.all(records.map(async record => {
      let availability: 'available' | 'unavailable' = 'unavailable'
      if (this.codec) {
        try {
          validateNames(record.variableNames)
          validateSecret(JSON.parse(await this.codec.decode(record.ciphertext, context(record.id, record.revision))), record.variableNames)
          availability = 'available'
        } catch { /* Incorrect key, tampered ciphertext or invalid record: never expose details. */ }
      }
      return { id: record.id, variableNames: record.variableNames, revision: record.revision, availability }
    }))
  }

  async put(input: { readonly id: string; readonly variableNames: readonly string[]; readonly secret: Readonly<Record<string, string>>; readonly expectedRevision: number }): Promise<{ id: string; variableNames: readonly string[]; revision: number; availability: 'available' }> {
    if (!this.codec) throw new ProviderCredentialError('credential_unavailable', 'Worker 未配置凭据加密密钥')
    if (!identifier.test(input.id) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new ProviderCredentialError('invalid_input', '模型凭据标识或版本无效')
    validateNames(input.variableNames)
    validateSecret(input.secret, input.variableNames)
    const previous = await this.repository.getProviderCredential(input.id)
    if ((previous?.revision ?? 0) !== input.expectedRevision) throw new ProviderCredentialError('revision_conflict', '模型凭据版本已变化')
    const revision = input.expectedRevision + 1
    const timestamp = new Date().toISOString()
    const record: ProviderCredentialRecord = {
      id: input.id, variableNames: [...input.variableNames],
      ciphertext: await this.codec.encode(JSON.stringify(input.secret), context(input.id, revision)),
      revision, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp,
    }
    if (!(await this.repository.saveProviderCredential(record, input.expectedRevision))) throw new ProviderCredentialError('revision_conflict', '模型凭据版本已变化')
    return { id: record.id, variableNames: record.variableNames, revision, availability: 'available' }
  }

  async resolve(id: string, variableNames: readonly string[]): Promise<Readonly<Record<string, string>>> {
    if (!this.codec) throw new ProviderCredentialError('credential_unavailable', '模型凭据加密能力不可用')
    validateNames(variableNames)
    const record = await this.repository.getProviderCredential(id)
    if (!record || !Array.isArray(record.variableNames) || record.variableNames.length !== variableNames.length || record.variableNames.some(name => !variableNames.includes(name))) throw new ProviderCredentialError('credential_unavailable', '模型凭据未配置或字段不匹配')
    try {
      const parsed: unknown = JSON.parse(await this.codec.decode(record.ciphertext, context(record.id, record.revision)))
      validateSecret(parsed, variableNames)
      return parsed
    } catch { throw new ProviderCredentialError('credential_unavailable', '模型凭据不可解密') }
  }

  async delete(id: string, expectedRevision: number): Promise<void> {
    if (!identifier.test(id) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ProviderCredentialError('invalid_input', '模型凭据标识或版本无效')
    const existing = await this.repository.getProviderCredential(id)
    if (!existing || existing.revision !== expectedRevision) throw new ProviderCredentialError('revision_conflict', '模型凭据版本已变化')
    if (!(await this.repository.deleteProviderCredential(id, expectedRevision))) throw new ProviderCredentialError('revision_conflict', '模型凭据版本已变化')
  }
}
