import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { WorkspaceProvisionSpec, WorkspaceId, ProjectId, RepositoryId } from '@wemux/domain'
import { LocalProvisioner } from '../src/workspaces/local-provisioner.ts'
const exec = promisify(execFile)

// Serial inside one test: LocalProvisioner inherits this isolated process Git environment.
test('LocalProvisioner retries the same Workspace after a missing non-default branch is created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wemux-revisions-'))
  const environment = { HOME: root, XDG_CONFIG_HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', GIT_TEMPLATE_DIR: join(root, 'templates'), GIT_CONFIG_PARAMETERS: undefined, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined }
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  const git = async (...args: string[]) => (await exec('git', args, { timeout: 15000 })).stdout.trim()
  const source = join(root, 'source'), managed = join(root, 'managed')
  const provisioner = new LocalProvisioner(managed)
  try {
    await mkdir(environment.GIT_TEMPLATE_DIR)
    await git('init', '--initial-branch=main', source)
    await writeFile(join(source, 'content.txt'), 'requested branch content\n')
    await git('-C', source, 'add', '.')
    await git('-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'requested')
    const requested = await git('-C', source, 'rev-parse', 'HEAD')
    await writeFile(join(source, 'content.txt'), 'newer default branch\n')
    await git('-C', source, 'add', '.')
    await git('-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'main')
    const input = (id: string, revision: string): WorkspaceProvisionSpec => ({ workspace: { id: id as WorkspaceId, name: id, projectId: 'project' as ProjectId, spec: { kind: 'repository', repositoryId: 'repo' as RepositoryId, ownership: { kind: 'standalone' } } }, repositories: [{ repositoryId: 'repo' as RepositoryId, gitUrl: source, revision }] })
    const request = input('same-workspace', 'repair-branch')
    await assert.rejects(provisioner.provision(request))
    assert.deepEqual(await readdir(managed), [], 'failure leaves no ready marker, root or staging')
    await git('-C', source, 'branch', 'repair-branch', requested)
    const result = await provisioner.provision(request)
    assert.equal(await git('-C', result.rootPath, 'rev-parse', 'HEAD'), requested)
    assert.equal(await readFile(join(result.rootPath, 'content.txt'), 'utf8'), 'requested branch content\n')
    await assert.rejects(git('-C', result.rootPath, 'symbolic-ref', '-q', 'HEAD'), 'checkout stays detached')
    await writeFile(join(result.rootPath, 'local.txt'), 'must survive replay')
    assert.deepEqual(await provisioner.provision(request), result)
    assert.equal(await readFile(join(result.rootPath, 'local.txt'), 'utf8'), 'must survive replay')
    const main = await git('-C', source, 'rev-parse', 'HEAD')
    const defaultBranch = await provisioner.provision(input('default-main', 'main'))
    assert.equal(await git('-C', defaultBranch.rootPath, 'rev-parse', 'HEAD'), main)
    await git('-C', source, 'tag', 'release', requested)
    await git('-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'tag.gpgsign=false', 'tag', '-a', 'annotated', '-m', 'release', requested)
    await git('-C', source, 'branch', 'collision', main)
    await git('-C', source, 'tag', 'collision', requested)
    await git('-C', source, 'tag', 'main', requested)
    // Native Git disambiguation is documented tag-before-head, even for default-branch collisions.
    for (const [revision, expected] of [['HEAD', main], ['refs/heads/main', main], ['release', requested], ['annotated', requested], [requested, requested], ['repair-branch', requested], ['refs/remotes/origin/repair-branch', requested], ['collision', requested], ['main', requested]]) {
      const materialized = await provisioner.provision(input(`revision-${revision}`, revision))
      assert.equal(await git('-C', materialized.rootPath, 'rev-parse', 'HEAD'), expected, revision)
      assert.equal(await readFile(join(materialized.rootPath, 'content.txt'), 'utf8'), expected === main ? 'newer default branch\n' : 'requested branch content\n', revision)
    }
    const blob = await git('-C', source, 'rev-parse', `${requested}:content.txt`)
    await git('-C', source, 'tag', 'noncommit', blob)
    await git('-C', source, 'branch', 'noncommit', main)
    const beforeFailures = (await readdir(managed)).sort()
    for (const revision of ['missing', '--help', '-b', 'bad\0revision', 'noncommit', 'refs/tags/absent']) {
      await assert.rejects(provisioner.provision(input(`invalid-${revision}`, revision)), { name: 'Error' }, revision)
      assert.deepEqual((await readdir(managed)).sort(), beforeFailures, 'no fallback HEAD or ready marker/staging for invalid revision')
    }
    const stopped = new LocalProvisioner(join(root, 'stopped'))
    await stopped.stop()
    await assert.rejects(stopped.provision(input('aborted', requested)), { name: 'AbortError' })
    assert.deepEqual(await readdir(join(root, 'stopped')), [], 'abort leaves no ready marker or staging')

  } finally {
    await provisioner.stop()
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(root, { recursive: true, force: true })
  }
})
