import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentKey, CredentialId, ModelId, ProjectId, SessionId, TeamId, UserId, WorkspaceId } from '@wemux/domain'
import { SqliteServerStore } from '../storage/sqlite/store.js'
import { firstAccountMigrationVersion, migrate, migrationCount } from '../storage/sqlite/migrations.js'
import { ServerService } from '../application/server-service.js'
import { TaskService } from '../application/task-service.js'
import { Notifications } from '../application/notifications.js'
import { hashSecret } from '../application/auth.js'
import { seedOperator, instanceOperatorId } from './fixtures/administrator.js'

const context = { actor: instanceOperatorId, requestId: 'account-upgrade' }

/** 把已迁移的镜像回退成"账号迁移之前"的实例：删掉登录会话表并撤销这些迁移的版本行。 */
const downgradeToPreAccount = (path: string): void => {
  const db = new DatabaseSync(path)
  db.exec('DROP TABLE IF EXISTS login_sessions; DROP TABLE IF EXISTS instance_claim;')
  db.exec('DROP TRIGGER IF EXISTS command_rejection_no_dispatch; DROP TABLE command_rejections')
  // v39/v40 的 attention 排序索引建在存活表上；只删版本行不删物理索引会让重放的 CREATE INDEX 撞名。
  db.exec('DROP INDEX IF EXISTS attention_failed_runs_order; DROP INDEX IF EXISTS attention_dead_letters_order; DROP INDEX IF EXISTS attention_human_reviews_order; DROP TABLE IF EXISTS workspace_account_visibility')
  db.prepare('DELETE FROM schema_migrations WHERE version >= ?').run(firstAccountMigrationVersion)
  db.close()
}

test('升级前实例：账号迁移保留真实归属，退役旧 PAT 并留下可审计报告', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wemux-account-upgrade-'))
  const path = join(dir, 'server.sqlite')
  const legacyTokens = ['wemux-session-legacy-one', 'wemux-session-legacy-two']
  let snapshot: readonly { kind: string; id: string; data: string }[] = []
  let scoped: { projectId: ProjectId; workspaceId: WorkspaceId; sessionId: SessionId; userId: UserId; teamId: TeamId; taskId: string }
  try {
    const store = new SqliteServerStore(path)
    const signals = new Notifications()
    const server = new ServerService(store, signals)
    const tasks = new TaskService(store, event => signals.project(event), server)
    const bootstrap = await seedOperator(store, server)

    // 升级前的实例里已经有真实的 Team、管理员、Project、Workspace、Session、Task 和旧 PAT。
    const { worker } = await server.enroll({ token: (await server.createEnrollment({})).token, name: 'Legacy worker' })
    await store.transaction(tx => tx.resources.saveWorker({ ...worker, connectionState: 'online', capabilities: [{ agentKey: 'test' as AgentKey, displayName: 'Test', version: null, mode: 'execution', availability: { status: 'available' }, models: [{ modelId: 'model' as ModelId, displayName: 'Model', source: 'configured' }] }] }))
    const task = await tasks.create('default-project', { title: 'Upgrade task' }, context)
    const { workspace } = await tasks.createWorkspace(task.projectId, task.id, { name: 'Legacy workspace', workerId: worker.id, source: 'empty' }, context)
    await store.transaction(tx => tx.resources.saveWorkspace({ ...workspace, status: 'ready' }))
    await tasks.assignment(task.projectId, task.id, { version: 1, assignee: { workspaceId: workspace.id, workerId: worker.id, agentKey: 'test', modelId: 'model' } }, false, context)
    const { session } = await tasks.createSession(task.projectId, task.id, { title: 'Upgrade session', requestId: 'upgrade-session' }, context)
    // 会话创建后把 Worker 恢复成镜像里真实的样子：连接状态不跨重启存活，不应被误认为迁移改写。
    await store.transaction(async tx => tx.resources.saveWorker({ ...(await tx.resources.getWorker(worker.id))!, connectionState: 'offline' }))
    await store.transaction(async tx => {
      for (const [index, secret] of legacyTokens.entries()) {
        await tx.identity.savePersonalAccessToken({
          id: `legacy-pat-${index}` as CredentialId, userId: bootstrap.user!.id, tokenHash: hashSecret(secret),
          expiresAt: null, revokedAt: null,
        })
      }
    })
    scoped = { projectId: task.projectId as ProjectId, workspaceId: workspace.id, sessionId: session.id, userId: bootstrap.user!.id, teamId: bootstrap.team!.id, taskId: task.id }
    store.close()

    // 升级：旧镜像重新打开时必须就地补齐账号迁移；真实归属不能被重写。
    // 基线在回退后、迁移前读取，因此比较的是“迁移本身是否改写数据”。
    downgradeToPreAccount(path)
    const rows = (): { kind: string; id: string; data: string }[] => (new DatabaseSync(path).prepare('SELECT kind,id,data FROM records ORDER BY kind,id').all() as { kind: string; id: string; data: string }[])
      .map(row => ({ kind: String(row.kind), id: String(row.id), data: String(row.data) }))
    snapshot = rows()
    // 实例管理员归属在独立表里（不是 records 行），因此单独取基线：升级前后必须一字不差。
    const administrators = (): string[] => (new DatabaseSync(path).prepare('SELECT user_id FROM instance_administrators').all() as { user_id: string }[]).map(row => String(row.user_id)).sort()
    const administratorsBefore = administrators()
    const upgraded = new SqliteServerStore(path)
    const preserved = rows()
    const retired = new Set(legacyTokens.map(secret => hashSecret(secret)))
    for (const row of snapshot) {
      const after = preserved.find(candidate => candidate.kind === row.kind && candidate.id === row.id)
      assert.ok(after, `升级不应删除 ${row.kind}/${row.id}`)
      // 唯一的预期改动是旧无 scope PAT 被显式退役；其它记录必须逐字节保留。
      if (row.kind === 'pat' && retired.has(JSON.parse(row.data).tokenHash)) {
        assert.equal(JSON.parse(row.data).revokedAt, null, '旧 PAT 升级前应当是未撤销的')
        assert.notEqual(JSON.parse(after.data).revokedAt, null, '旧 PAT 升级后必须已退役')
        assert.equal(JSON.stringify({ ...JSON.parse(after.data), revokedAt: null }), row.data)
        continue
      }
      assert.equal(after.data, row.data, `升级不能改写 ${row.kind}/${row.id} 的归属或内容`)
    }
    // 管理员、Team、Project、Workspace、Session、Task 的归属都还在。
    assert.equal((await upgraded.identity.getUser(scoped.userId))?.id, scoped.userId)
    assert.equal((await upgraded.identity.getTeam(scoped.teamId))?.id, scoped.teamId)
    assert.equal((await upgraded.resources.getProject(scoped.projectId))?.ownerId, scoped.userId)
    assert.equal((await upgraded.resources.getWorkspace(scoped.workspaceId))?.projectId, scoped.projectId)
    assert.equal((await upgraded.resources.getSession(scoped.sessionId))?.ownerId, scoped.userId)
    assert.equal((await upgraded.tasks.get(scoped.taskId))?.projectId, scoped.projectId)
    // 升级不自行提权：实例管理员归属只由部署声明 + 登录时补齐，迁移既不新增也不删除归属。
    assert.deepEqual(administrators(), administratorsBefore, '升级不得凭空增加或删除实例管理员归属')
    // 旧凭证的退役只针对无 scope 的旧 PAT，并且留下了可审计报告；带有效期的新 PAT 不受影响。
    const tokens = await upgraded.identity.listPersonalAccessTokens()
    assert.equal(tokens.filter(token => token.expiresAt === null && token.revokedAt === null).length, 0, '旧无 scope PAT 必须全部退役')
    assert.equal(tokens.filter(token => token.revokedAt === null).length, 1, '带有效期的新 PAT 升级后仍然有效')
    const report = (await upgraded.identity.listAudit(20)).find(entry => entry.id === 'upgrade-legacy-pat-retirement')
    assert.ok(report, '升级必须留下 credentials.legacy_pat_retired 审计条目')
    assert.equal(report.action, 'credentials.legacy_pat_retired')
    assert.equal((report.metadata as { retiredCount: number }).retiredCount, legacyTokens.length)
    const versions = (new DatabaseSync(path).prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n
    assert.equal(versions, migrationCount)
    upgraded.close()

    // 重放必须幂等：版本行、审计报告和退役时间都不再变化。
    const db = new DatabaseSync(path)
    migrate(db)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n, migrationCount)
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM records WHERE id='upgrade-legacy-pat-retirement'").get() as { n: number }).n, 1)
    const replayed = rows()
    assert.deepEqual(replayed, preserved)
    db.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('账号迁移是 append-only：新迁移只能追加在 Ticket 04 之后', () => {
  // 升级测试依赖 firstAccountMigrationVersion 固定不动；如果账号迁移被重排或插入到中间，这里先失败。
  assert.equal(firstAccountMigrationVersion <= migrationCount, true)
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const versions = (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map(row => row.version)
  assert.deepEqual(versions, Array.from({ length: migrationCount }, (_, index) => index + 1))
  db.close()
})