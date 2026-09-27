import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath, readdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Timestamp } from '@wemux/domain'
import type { WorkspaceDiffLine } from '@wemux/wire-protocol'

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

export interface WorkspaceFileDiff {
  readonly supported: boolean
  readonly reason?: 'not-git'
  readonly lines: readonly WorkspaceDiffLine[]
}

const execFileAsync = promisify(execFile)
const MAX_GIT_DIFF_BUFFER = 16 * 1024 * 1024

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

const parseRangeStart = (value: string | undefined): number => {
  if (!value) return 0
  const match = /^(\d+)(?:,\d+)?$/.exec(value)
  if (!match) throw new Error('Invalid git diff hunk')
  return Number(match[1])
}

export function parseGitDiff(output: string): readonly WorkspaceDiffLine[] {
  const lines: WorkspaceDiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const line of output.split('\n')) {
    const hunk = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@/.exec(line)
    if (hunk) {
      oldLine = parseRangeStart(hunk[1])
      newLine = parseRangeStart(hunk[2])
      inHunk = true
      continue
    }
    if (!inHunk || line === '\\ No newline at end of file') continue
    if (line.startsWith('+')) {
      lines.push({ type: 'add', newLine: newLine++, text: line.slice(1) })
    } else if (line.startsWith('-')) {
      lines.push({ type: 'del', oldLine: oldLine++, text: line.slice(1) })
    } else if (line.startsWith(' ')) {
      lines.push({ type: 'ctx', oldLine: oldLine++, newLine: newLine++, text: line.slice(1) })
    }
  }
  return lines
}

const diffAgainstEmpty = async (repositoryRoot: string, repositoryPath: string): Promise<WorkspaceFileDiff> => {
  const result = await execFileAsync('git', ['-C', repositoryRoot, 'diff', '--no-index', '--no-color', '--unified=3', '--', '/dev/null', repositoryPath], { encoding: 'utf8', maxBuffer: MAX_GIT_DIFF_BUFFER })
    .catch(error => error as { stdout?: string; code?: number })
  if ('code' in result && result.code !== undefined && result.code !== 1) throw new Error('Unable to diff untracked file')
  return { supported: true, lines: parseGitDiff(result.stdout ?? '') }
}

export async function diffWorkspaceFile(workspaceRoot: string, subpath: string): Promise<WorkspaceFileDiff> {
  if (typeof subpath !== 'string' || !subpath || subpath.includes('\0') || isAbsolute(subpath)) throw new Error('Invalid workspace path')
  const root = await realpath(workspaceRoot)
  const candidate = resolve(root, subpath)
  assertInside(root, candidate)
  let target = candidate
  try {
    const stat = await lstat(candidate)
    if (!stat.isFile()) throw new Error('Path is not a file')
    target = await realpath(candidate)
    assertInside(root, target)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  let repositoryRoot: string
  try {
    const result = await execFileAsync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', maxBuffer: 64 * 1024 })
    repositoryRoot = await realpath(result.stdout.trim())
  } catch {
    return { supported: false, reason: 'not-git', lines: [] }
  }
  assertInside(repositoryRoot, root)
  assertInside(repositoryRoot, target)
  const repositoryPath = relative(repositoryRoot, target).replaceAll('\\', '/')
  const hasHead = await execFileAsync('git', ['-C', repositoryRoot, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', maxBuffer: 64 * 1024 }).then(() => true, () => false)
  const tracked = hasHead && await execFileAsync('git', ['-C', repositoryRoot, 'ls-files', '--error-unmatch', '--', repositoryPath], { encoding: 'utf8', maxBuffer: 64 * 1024 }).then(() => true, () => false)
  if (!tracked) {
    if (target === candidate) {
      try { await lstat(candidate) } catch { return { supported: true, lines: [] } }
    }
    return diffAgainstEmpty(repositoryRoot, repositoryPath)
  }
  const { stdout } = await execFileAsync('git', ['-C', repositoryRoot, 'diff', '--no-ext-diff', '--no-color', '--unified=3', 'HEAD', '--', repositoryPath], { encoding: 'utf8', maxBuffer: MAX_GIT_DIFF_BUFFER })
  return { supported: true, lines: parseGitDiff(stdout) }
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
