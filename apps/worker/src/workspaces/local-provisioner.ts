import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { WorkspaceProvisionSpec } from '@wemux/domain'
import type { WorkspaceProvisioner } from '../application/ports/local-state.js'
const exec = promisify(execFile)

export class LocalProvisioner implements WorkspaceProvisioner {
  private readonly controller = new AbortController()
  constructor(private readonly root: string) {}
  async stop() { this.controller.abort() }
  async provision(input: WorkspaceProvisionSpec) {
    const { workspace, repositories } = input
    if (workspace.spec.kind === 'composite' && (workspace.spec.memberWorkspaceIds.length || repositories.length)) throw new Error('MVP supports only empty composite workspaces')
    if (workspace.spec.kind === 'repository' && (repositories.length !== 1 || repositories[0].repositoryId !== workspace.spec.repositoryId)) throw new Error('Repository checkout must match workspace repository')
    const key = createHash('sha256').update(workspace.id).digest('hex')
    const rootPath = join(this.root, key)
    const marker = join(this.root, `${key}.ready`)
    const signature = JSON.stringify({ spec: workspace.spec, repositories })
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    try {
      if (await readFile(marker, 'utf8') !== signature) throw new Error('Conflicting provision specification')
      return this.result(input, rootPath)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const staging = join(this.root, `${key}.partial`)
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { mode: 0o700 })
    try {
      if (workspace.spec.kind === 'repository') {
        const repository = repositories[0]
        if (!repository.gitUrl || repository.gitUrl.startsWith('-') || repository.gitUrl.includes('\0') || !repository.revision || repository.revision.startsWith('-')) throw new Error('Invalid git source or revision')
        const options = { signal: this.controller.signal, timeout: 120000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
        await exec('git', ['clone', '--no-checkout', '--', repository.gitUrl, staging], options)
        await exec('git', ['-C', staging, 'checkout', '--detach', repository.revision, '--'], options)
      }
      // A crash after rename is safe: only Worker-owned paths are replaced on retry.
      await rm(rootPath, { recursive: true, force: true })
      await rename(staging, rootPath)
      await writeFile(marker, signature, { mode: 0o600 })
      return this.result(input, rootPath)
    } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
  }
  private result(input: WorkspaceProvisionSpec, rootPath: string) {
    return { rootPath, checkouts: input.repositories.map(repository => ({ workspaceId: input.workspace.id, repositoryId: repository.repositoryId, absolutePath: rootPath, revision: repository.revision })) }
  }
}
