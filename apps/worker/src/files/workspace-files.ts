import { constants } from 'node:fs'
import { lstat, open, realpath, readdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Timestamp } from '@wemux/domain'

export const MAX_FILE_READ_BYTES = 1024 * 1024

export interface WorkspaceFileEntry {
  readonly name: string
  readonly type: 'file' | 'directory'
  readonly size: number
  readonly mtime: Timestamp
}

export interface WorkspaceFileRead {
  readonly content: string | null
  readonly size: number
  readonly truncated: boolean
  readonly binary: boolean
}

const assertInside = (root: string, target: string) => {
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('Path escapes workspace root')
  }
}

const resolveWorkspacePath = async (workspaceRoot: string, subpath: string): Promise<string> => {
  if (typeof subpath !== 'string' || subpath.includes('\0') || isAbsolute(subpath)) throw new Error('Invalid workspace path')
  const root = await realpath(workspaceRoot)
  const candidate = resolve(root, subpath || '.')
  assertInside(root, candidate)
  const target = await realpath(candidate)
  assertInside(root, target)
  return target
}

export async function listWorkspaceFiles(workspaceRoot: string, subpath: string): Promise<readonly WorkspaceFileEntry[]> {
  const target = await resolveWorkspacePath(workspaceRoot, subpath)
  const targetStat = await lstat(target)
  if (!targetStat.isDirectory()) throw new Error('Path is not a directory')
  const entries: WorkspaceFileEntry[] = []
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    if (!entry.isDirectory() && !entry.isFile()) continue
    const stat = await lstat(resolve(target, entry.name))
    entries.push({
      name: entry.name,
      type: stat.isDirectory() ? 'directory' : 'file',
      size: stat.size,
      mtime: stat.mtime.toISOString() as Timestamp,
    })
  }
  return entries.sort((left, right) => left.type === right.type
    ? left.name.localeCompare(right.name)
    : left.type === 'directory' ? -1 : 1)
}

export async function readWorkspaceFile(workspaceRoot: string, subpath: string, maxBytes: number): Promise<WorkspaceFileRead> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FILE_READ_BYTES) throw new Error(`maxBytes must be between 1 and ${MAX_FILE_READ_BYTES}`)
  const target = await resolveWorkspacePath(workspaceRoot, subpath)
  const stat = await lstat(target)
  if (!stat.isFile()) throw new Error('Path is not a file')
  const length = Math.min(stat.size, maxBytes)
  const buffer = Buffer.alloc(length)
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    const bytes = buffer.subarray(0, bytesRead)
    let content: string | null = null
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { /* Invalid UTF-8 is binary for preview purposes. */ }
    const binary = content === null || bytes.includes(0)
    return {
      content: binary ? null : content,
      size: stat.size,
      truncated: stat.size > bytesRead,
      binary,
    }
  } finally {
    await handle.close()
  }
}
