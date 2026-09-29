import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { ResourceBindingSnapshot } from '@wemux/domain'
import type { InstalledResourceState, ResourceStateStore } from './resource-state-store.ts'

export interface SkillBlobFetcher {
  fetch(sha256: string): Promise<Uint8Array>
}

export interface ResourceGcPolicy { readonly maxRetainedRevisions: number }
export interface ResourceGcReport { readonly removed: readonly string[]; readonly retained: readonly string[] }

function safeSegment(value: string): string {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) throw new Error('invalid_resource_path')
  return value
}

function safePath(root: string, path: string): string {
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/') || path.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error('invalid_resource_path')
  const target = resolve(root, path)
  if (relative(root, target).startsWith('..')) throw new Error('invalid_resource_path')
  return target
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function linkTarget(path: string): Promise<string | null> {
  try { return await readlink(path) } catch { return null }
}

export class SkillMaterializer {
  private readonly home: string
  private readonly state: ResourceStateStore
  private readonly now: () => string

  constructor(home: string, state: ResourceStateStore, now: () => string = () => new Date().toISOString()) {
    this.home = home
    this.state = state
    this.now = now
  }

  async verify(binding: ResourceBindingSnapshot): Promise<boolean> {
    safeSegment(binding.resourceId)
    safeSegment(binding.resourceRevisionId)
    const installed = this.state.installed(binding.resourceId)
    if (!installed || installed.resourceRevisionId !== binding.resourceRevisionId || installed.integrity !== binding.contentSha256) return false
    const resourceRoot = resolve(this.home, 'resources', 'skill', binding.resourceId, 'revisions')
    const canonical = await realpath(installed.path).catch(() => null)
    if (!canonical || !canonical.startsWith(resourceRoot + '/')) return false
    for (const file of binding.files) {
      if (!(await realpath(safePath(installed.path, file.path)).catch(() => '')).startsWith(canonical + '/')) return false
      const expected = installed.files[file.path]
      if (expected !== file.sha256 || await hashFile(safePath(installed.path, file.path)).catch(() => '') !== file.sha256) return false
    }
    return true
  }

  async materialize(binding: ResourceBindingSnapshot, blobs: SkillBlobFetcher): Promise<InstalledResourceState> {
    if (binding.kind !== 'skill') throw new Error('unsupported_resource_kind')
    if (!binding.files.some(file => file.path === 'SKILL.md')) throw new Error('skill_entry_missing')
    const resourceRoot = join(this.home, 'resources', 'skill', safeSegment(binding.resourceId))
    safeSegment(binding.resourceRevisionId)
    const installedBefore = this.state.installed(binding.resourceId)
    const revisionsRoot = join(resourceRoot, 'revisions')
    const revisionRoot = join(revisionsRoot, binding.resourceRevisionId)
    let activatedRoot = revisionRoot
    const stagingRoot = join(resourceRoot, `.staging-${binding.resourceRevisionId}-${randomUUID()}`)
    await mkdir(stagingRoot, { recursive: true })
    try {
      for (const file of binding.files) {
        const target = safePath(stagingRoot, file.path)
        await mkdir(dirname(target), { recursive: true })
        const content = await blobs.fetch(file.blobSha256)
        if (content.byteLength !== file.size || createHash('sha256').update(content).digest('hex') !== file.sha256) throw new Error('resource_file_hash_mismatch')
        await writeFile(target, content, { flag: 'wx' })
      }
      for (const file of binding.files) if (await hashFile(safePath(stagingRoot, file.path)) !== file.sha256) throw new Error('resource_file_hash_mismatch')
      await mkdir(revisionsRoot, { recursive: true })
      try { await rename(stagingRoot, revisionRoot) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
        const existingValid = (await Promise.all(binding.files.map(file => hashFile(safePath(revisionRoot, file.path)).catch(() => '')))).every((value, index) => value === binding.files[index]!.sha256)
        if (existingValid) await rm(stagingRoot, { recursive: true, force: true })
        else {
          activatedRoot = join(revisionsRoot, `${binding.resourceRevisionId}-${randomUUID()}`)
          await rename(stagingRoot, activatedRoot)
        }
      }
      const current = join(resourceRoot, 'current')
      const previous = join(resourceRoot, 'previous')
      const oldCurrent = await linkTarget(current)
      const preserveOldCurrent = installedBefore !== null && installedBefore.resourceRevisionId !== binding.resourceRevisionId
      const temporary = join(resourceRoot, `.current-${randomUUID()}`)
      await symlink(relative(resourceRoot, activatedRoot), temporary, 'dir')
      if (oldCurrent && preserveOldCurrent && oldCurrent !== relative(resourceRoot, activatedRoot)) {
        const previousTemporary = join(resourceRoot, `.previous-${randomUUID()}`)
        await symlink(oldCurrent, previousTemporary, 'dir')
        await rename(previousTemporary, previous)
      }
      await rename(temporary, current)
      const at = this.now()
      const installed: InstalledResourceState = {
        bindingId: binding.bindingId, resourceId: binding.resourceId, resourceRevisionId: binding.resourceRevisionId,
        kind: 'skill', integrity: binding.contentSha256, files: Object.fromEntries(binding.files.map(file => [file.path, file.sha256])),
        path: activatedRoot, installedAt: at, lastUsedAt: at,
      }
      this.state.saveInstalled(installed)
      return installed
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true })
      throw error
    }
  }

  async resolveSkillPath(resourceId: string): Promise<string | null> {
    const installed = this.state.installed(resourceId)
    if (!installed) return null
    const resourceRoot = resolve(this.home, 'resources', 'skill', safeSegment(resourceId), 'revisions')
    const path = await realpath(installed.path).catch(() => null)
    if (!path || !path.startsWith(resourceRoot + '/')) return null
    this.state.touch(resourceId, this.now())
    return path
  }

  async collectGarbage(resourceId: string, policy: ResourceGcPolicy): Promise<ResourceGcReport> {
    const resourceRoot = join(this.home, 'resources', 'skill', safeSegment(resourceId))
    const revisionsRoot = join(resourceRoot, 'revisions')
    const protectedTargets = new Set<string>()
    for (const name of ['current', 'previous']) {
      const target = await linkTarget(join(resourceRoot, name))
      if (target) protectedTargets.add(resolve(resourceRoot, target))
    }
    const entries = await readdir(revisionsRoot, { withFileTypes: true }).catch(() => [])
    const usedByRevision = new Map(this.state.listInstalled().filter(item => item.resourceId === resourceId).map(item => [item.path, Date.parse(item.lastUsedAt)]))
    const candidates = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
      const path = join(revisionsRoot, entry.name)
      return { path, used: usedByRevision.get(path) ?? (await stat(path)).mtimeMs }
    }))
    candidates.sort((left, right) => right.used - left.used)
    const unprotected = candidates.filter(item => !protectedTargets.has(resolve(item.path)))
    const keep = new Set(unprotected.slice(0, Math.max(0, policy.maxRetainedRevisions)).map(item => item.path))
    const removed: string[] = []
    for (const item of unprotected) {
      if (keep.has(item.path)) continue
      // Pointer 状态可能在异步遍历期间改变；删除前重核强引用。
      const active = await Promise.all(['current', 'previous'].map(name => linkTarget(join(resourceRoot, name))))
      if (active.some(target => target && resolve(resourceRoot, target) === resolve(item.path))) continue
      const trash = join(resourceRoot, `.trash-${randomUUID()}`)
      await rename(item.path, trash)
      await rm(trash, { recursive: true, force: true })
      removed.push(item.path)
    }
    return { removed, retained: candidates.filter(item => !removed.includes(item.path)).map(item => item.path) }
  }
}
