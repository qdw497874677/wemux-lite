import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface StoredResourceBlob {
  readonly sha256: string
  readonly size: number
  readonly path: string
  readonly deduplicated: boolean
}

export class ResourceBlobStore {
  readonly root: string

  constructor(root: string) { this.root = root }

  async put(content: Uint8Array, expectedSha256?: string): Promise<StoredResourceBlob> {
    const sha256 = createHash('sha256').update(content).digest('hex')
    if (expectedSha256 && expectedSha256 !== sha256) throw new Error('resource_blob_hash_mismatch')
    const path = this.pathFor(sha256)
    try {
      const existing = await stat(path)
      if (existing.size !== content.byteLength) throw new Error('resource_blob_size_mismatch')
      return { sha256, size: existing.size, path, deduplicated: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, content, { flag: 'wx' })
    try { await rename(temporary, path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await unlink(temporary).catch(() => undefined)
    }
    return { sha256, size: content.byteLength, path, deduplicated: false }
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('invalid_resource_blob_hash')
    try { return await readFile(this.pathFor(sha256)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  pathFor(sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('invalid_resource_blob_hash')
    return join(this.root, sha256.slice(0, 2), sha256.slice(2, 4), sha256)
  }
}
