import assert from 'node:assert/strict'
import test from 'node:test'
import { IdentityService, type LoginSessionPolicy } from './identity-service.ts'
import { AdministratorDirectory } from './administrator-directory.ts'
import { AppError } from './errors.ts'
import { SqliteServerStore } from '../storage/sqlite/store.ts'
import { seedLocalAccount } from '../test/fixtures/administrator.ts'
import { createWemuxServer } from '../server.ts'
import { AuthenticationService } from './auth.ts'
import { httpHandler } from '../http/handler.ts'
import { SessionStreams } from '../http/sse.ts'

const email = 'expiry-only@example.test'
const password = 'synthetic-expiry-password'

test('IdentityService.touch cannot revive an idle-expired session resolved by an in-flight request', async () => {
  const store = new SqliteServerStore(':memory:')
  let now = Date.now()
  const clock = { now: () => new Date(now) }
  const policy: LoginSessionPolicy = { idleMs: 100, absoluteMs: 1000, touchIntervalMs: 0, reauthenticateMs: 100 }
  const identity = new IdentityService(store, new AdministratorDirectory(store.identity, [email]), clock, policy)
  try {
    const user = await seedLocalAccount(store, { email, username: email, password })
    const issued = await identity.issue(user, 'expiry-test')
    const resolved = await identity.resolveSession(issued.token)
    assert.ok(resolved)
    now += 100
    await assert.rejects(identity.touch(resolved), (error: unknown) => error instanceof AppError && error.status === 401)
    assert.equal(await identity.resolveSession(issued.token), null)
    assert.equal((await store.identity.getLoginSession(issued.session.id))?.idleExpiresAt, issued.session.idleExpiresAt)
  } finally { store.close() }
})

test('IdentityService.touch accepts a stale snapshot after another request renews the committed session', async () => {
  const store = new SqliteServerStore(':memory:')
  let now = 0
  const identity = new IdentityService(store, new AdministratorDirectory(store.identity, [email]), { now: () => new Date(now) },
    { idleMs: 100, absoluteMs: 1000, touchIntervalMs: 0, reauthenticateMs: 100 })
  try {
    const user = await seedLocalAccount(store, { email, username: email, password })
    const issued = await identity.issue(user, 'concurrent-expiry-test')
    const a = await identity.resolveSession(issued.token)
    const b = await identity.resolveSession(issued.token)
    assert.ok(a); assert.ok(b); assert.notStrictEqual(a, b)
    assert.equal(Date.parse(a.idleExpiresAt), 100)
    assert.equal(Date.parse(b.idleExpiresAt), 100)
    now = 90
    await identity.touch(b)
    assert.equal(Date.parse((await store.identity.getLoginSession(a.id))!.idleExpiresAt), 190)
    now = 100
    await assert.doesNotReject(async () => {
      const touched = await identity.touch(a)
      assert.equal(Date.parse(touched.idleExpiresAt), 200)
    })
    assert.equal(Date.parse((await store.identity.getLoginSession(a.id))!.idleExpiresAt), 200)
    assert.ok(await identity.resolveSession(issued.token))
  } finally { store.close() }
})

test('HTTP touch of a stale renewed snapshot succeeds without clearing the login cookie', async () => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [email], mail: {}, google: {} })
  let now = 0
  const administrators = new AdministratorDirectory(app.store.identity, [email])
  // Inject the deterministic A/B interleaving at the real handler's resolve → touch seam.
  class InterleavedIdentity extends IdentityService {
    override async resolveSession(token: string | undefined) {
      const a = await super.resolveSession(token)
      const b = await super.resolveSession(token)
      assert.ok(a); assert.ok(b); assert.notStrictEqual(a, b)
      assert.equal(Date.parse(a.idleExpiresAt), 100)
      assert.equal(Date.parse(b.idleExpiresAt), 100)
      now = 90
      await this.touch(b)
      assert.equal(Date.parse((await app.store.identity.getLoginSession(a.id))!.idleExpiresAt), 190)
      now = 100
      return a
    }
  }
  const policy = { idleMs: 100, absoluteMs: 1000, touchIntervalMs: 0, reauthenticateMs: 100 }
  const clock = { now: () => new Date(now) }
  const identity = new InterleavedIdentity(app.store, administrators, clock, policy)
  const streams = new SessionStreams(app.service)
  app.server.removeAllListeners('request')
  app.server.on('request', httpHandler({ identity, service: app.service, auth: new AuthenticationService(app.store, administrators), streams }))
  const origin = await app.listen(0)
  try {
    const user = await seedLocalAccount(app.store, { email, username: email, password })
    const issued = await identity.issue(user, 'http-concurrent-expiry-test')
    const response = await fetch(origin + '/api/auth/sessions', { headers: { Cookie: `wemux_login_session=${issued.token}` } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('set-cookie'), null)
    await response.json()
    assert.equal(Date.parse((await app.store.identity.getLoginSession(issued.session.id))!.idleExpiresAt), 200)
    const reader = new IdentityService(app.store, administrators, clock, policy)
    assert.ok(await reader.resolveSession(issued.token))
  } finally { streams.close(); await app.close() }
})

test('IdentityService.touch cannot revive a session revoked ahead of it in the transaction queue', async () => {
  const store = new SqliteServerStore(':memory:')
  let now = 0
  const identity = new IdentityService(store, new AdministratorDirectory(store.identity, [email]), { now: () => new Date(now) },
    { idleMs: 100, absoluteMs: 1000, touchIntervalMs: 0, reauthenticateMs: 100 })
  try {
    const user = await seedLocalAccount(store, { email, username: email, password })
    const issued = await identity.issue(user, 'queued-revocation-test')
    const resolved = await identity.resolveSession(issued.token)
    assert.ok(resolved)
    now = 90
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const revokedAt = new Date(now).toISOString() as typeof resolved.createdAt
    const revoke = store.transaction(async tx => {
      await barrier
      await tx.identity.revokeLoginSession(resolved.id, revokedAt)
    })
    const touch = assert.rejects(identity.touch(resolved), (error: unknown) => error instanceof AppError && error.status === 401)
    release()
    await revoke; await touch
    const stored = await store.identity.getLoginSession(resolved.id)
    assert.equal(stored?.revokedAt, revokedAt)
    assert.equal(stored?.idleExpiresAt, issued.session.idleExpiresAt)
    assert.equal(await identity.resolveSession(issued.token), null)
  } finally { store.close() }
})

for (const deadline of ['idle', 'absolute'] as const) {
  test(`IdentityService.touch checks ${deadline} expiry after waiting for its transaction`, async () => {
    const store = new SqliteServerStore(':memory:')
    let now = 0
    const identity = new IdentityService(store, new AdministratorDirectory(store.identity, [email]), { now: () => new Date(now) },
      { idleMs: 100, absoluteMs: 1000, touchIntervalMs: 0, reauthenticateMs: 100 })
    try {
      const user = await seedLocalAccount(store, { email, username: email, password })
      const issued = await identity.issue(user, 'queued-expiry-test')
      if (deadline === 'absolute') {
        for (now = 90; now <= 990; now += 90) await identity.touch((await identity.resolveSession(issued.token))!)
        now = 998
      } else now = 99
      const resolved = await identity.resolveSession(issued.token)
      assert.ok(resolved)
      if (deadline === 'absolute') assert.equal(Date.parse(resolved.idleExpiresAt), 999)
      let release!: () => void
      const barrier = new Promise<void>(resolve => { release = resolve })
      const blocker = store.transaction(async () => { await barrier; now = deadline === 'idle' ? 100 : 1000 })
      const touch = assert.rejects(identity.touch(resolved), (error: unknown) => error instanceof AppError && error.status === 401)
      release()
      await blocker; await touch
      assert.equal((await store.identity.getLoginSession(resolved.id))?.idleExpiresAt, resolved.idleExpiresAt)
      assert.equal(await identity.resolveSession(issued.token), null)
    } finally { store.close() }
  })
}

test('IdentityService.touch uses the committed lastSeenAt for its touch interval', async () => {
  const store = new SqliteServerStore(':memory:')
  let now = 0
  const identity = new IdentityService(store, new AdministratorDirectory(store.identity, [email]), { now: () => new Date(now) },
    { idleMs: 100, absoluteMs: 1000, touchIntervalMs: 50, reauthenticateMs: 100 })
  try {
    const user = await seedLocalAccount(store, { email, username: email, password })
    const issued = await identity.issue(user, 'touch-interval-test')
    const a = await identity.resolveSession(issued.token)
    const b = await identity.resolveSession(issued.token)
    assert.ok(a); assert.ok(b)
    now = 90
    const renewed = await identity.touch(b)
    now = 100
    assert.deepEqual(await identity.touch(a), renewed)
    assert.deepEqual(await store.identity.getLoginSession(a.id), renewed)
    assert.ok(await identity.resolveSession(issued.token))
  } finally { store.close() }
})

test('HTTP anonymous, expired, revoked and authVersion-retired cookies share a non-enumerating structured 401', async () => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [email], mail: {}, google: {}, adminSessionTtlMs: 60_000 })
  const origin = await app.listen(0)
  try {
    const user = await seedLocalAccount(app.store, { email, username: email, password })
    const expected = { error: { code: 'authentication_required', message: '登录凭据无效或已失效，请重新登录。' } }
    async function rejected(cookie?: string) {
      for (const path of ['/api/auth/me', '/api/projects']) {
        const response = await fetch(origin + path, { headers: cookie ? { Cookie: cookie } : {} })
        assert.equal(response.status, 401)
        assert.deepEqual(await response.json(), expected)
        assert.equal(response.headers.get('cache-control'), 'no-store')
        if (cookie) assert.match(response.headers.get('set-cookie') ?? '', /wemux_login_session=;.*Max-Age=0/)
      }
    }
    await rejected()
    await rejected('wemux_login_session=unknown-synthetic-token')
    for (const reason of ['idle', 'absolute', 'revoked', 'authVersion'] as const) {
      const past = reason === 'idle' || reason === 'absolute'
      const clock = { now: () => new Date(Date.now() - (past ? 3000 : 0)) }
      const policy = { idleMs: 1000, absoluteMs: reason === 'absolute' ? 2000 : 60_000, touchIntervalMs: 0, reauthenticateMs: 1000 }
      const identity = new IdentityService(app.store, new AdministratorDirectory(app.store.identity, [email]), clock, policy)
      const issued = await identity.issue(user, 'expiry-test')
      if (reason === 'revoked') await identity.revokeSession(user.id, issued.session.id)
      if (reason === 'authVersion') await app.store.transaction(tx => tx.identity.saveUser({ ...user, authVersion: (user.authVersion ?? 0) + 1 }))
      await rejected(`wemux_login_session=${issued.token}`)
    }
  } finally { await app.close() }
})

// Pause outside the committed reader's FIFO lease; only scheduling is injected,
// not the session/user records or the authorization decision.
function pauseFirstUserRead(store: SqliteServerStore) {
  let reached!: () => void
  let release!: () => void
  const waiting = new Promise<void>(resolve => { reached = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  let armed = true
  const identity = {
    ...store.identity,
    getUser: async (...args: Parameters<typeof store.identity.getUser>) => {
      const user = await store.identity.getUser(...args)
      if (armed) { armed = false; reached(); await barrier }
      return user
    },
  }
  const reader = new Proxy(store, {
    get(target, key) {
      if (key === 'identity') return identity
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { reader, waiting, release }
}

test('IdentityService.resolveSession rechecks a renewed session after its user read crosses the old idle deadline', async () => {
  const store = new SqliteServerStore(':memory:')
  let now = 0
  const administrators = new AdministratorDirectory(store.identity, [email])
  const clock = { now: () => new Date(now) }
  const policy = { idleMs: 100, absoluteMs: 1000, touchIntervalMs: 0, reauthenticateMs: 100 }
  const identity = new IdentityService(store, administrators, clock, policy)
  const pause = pauseFirstUserRead(store)
  try {
    const user = await seedLocalAccount(store, { email, username: email, password })
    const issued = await identity.issue(user, 'resolve-concurrent-expiry-test')
    const b = await identity.resolveSession(issued.token)
    assert.ok(b)
    assert.equal(Date.parse(b.idleExpiresAt), 100)
    const a = new IdentityService(pause.reader, administrators, clock, policy).resolveSession(issued.token)
    await pause.waiting
    now = 90
    await identity.touch(b)
    const renewed = await store.identity.getLoginSession(b.id)
    assert.equal(Date.parse(renewed!.idleExpiresAt), 190)
    now = 100
    pause.release()
    assert.deepEqual(await a, renewed)
    assert.deepEqual(await store.identity.getLoginSession(b.id), renewed)
    assert.deepEqual(await identity.resolveSession(issued.token), renewed)
  } finally { pause.release(); store.close() }
})

test('HTTP resolve across a concurrent renewal succeeds without clearing the login cookie or rolling back expiry', async () => {
  const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [email], mail: {}, google: {} })
  let now = 0
  const administrators = new AdministratorDirectory(app.store.identity, [email])
  const clock = { now: () => new Date(now) }
  const policy = { idleMs: 100, absoluteMs: 1000, touchIntervalMs: 0, reauthenticateMs: 100 }
  const pause = pauseFirstUserRead(app.store)
  const identity = new IdentityService(pause.reader, administrators, clock, policy)
  const reader = new IdentityService(app.store, administrators, clock, policy)
  const streams = new SessionStreams(app.service)
  app.server.removeAllListeners('request')
  app.server.on('request', httpHandler({ identity, service: app.service, auth: new AuthenticationService(app.store, administrators), streams }))
  const origin = await app.listen(0)
  try {
    const user = await seedLocalAccount(app.store, { email, username: email, password })
    const issued = await reader.issue(user, 'http-resolve-concurrent-expiry-test')
    const b = await reader.resolveSession(issued.token)
    assert.ok(b)
    assert.equal(Date.parse(b.idleExpiresAt), 100)
    const request = fetch(origin + '/api/auth/sessions', { headers: { Cookie: `wemux_login_session=${issued.token}` } })
    await pause.waiting
    now = 90
    await reader.touch(b)
    assert.equal(Date.parse((await app.store.identity.getLoginSession(b.id))!.idleExpiresAt), 190)
    now = 100
    pause.release()
    const response = await request
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/)
    await response.json()
    const stored = await app.store.identity.getLoginSession(b.id)
    assert.equal(Date.parse(stored!.idleExpiresAt), 200)
    assert.equal(Date.parse(stored!.lastSeenAt), 100)
    assert.equal(stored!.absoluteExpiresAt, issued.session.absoluteExpiresAt)
    assert.equal(stored!.revokedAt, null)
    assert.deepEqual(await reader.resolveSession(issued.token), stored)
  } finally { pause.release(); streams.close(); await app.close() }
})

// Count calls while delegating every read and transaction to the real SQLite store.
function countResolveReads(store: SqliteServerStore) {
  const counts = { transactions: 0, tokenHashQueries: 0, userQueries: 0 }
  function countedIdentity<T extends SqliteServerStore['identity']>(identity: T): T {
    return {
      ...identity,
      findLoginSessionByTokenHash: async hash => {
        counts.tokenHashQueries++
        return identity.findLoginSessionByTokenHash(hash)
      },
      getUser: async id => {
        counts.userQueries++
        return identity.getUser(id)
      },
    }
  }
  const identity = countedIdentity(store.identity)
  const transaction: typeof store.transaction = work => {
    counts.transactions++
    return store.transaction(tx => work({ ...tx, identity: countedIdentity(tx.identity) }))
  }
  const reader = new Proxy(store, {
    get(target, key) {
      if (key === 'identity') return identity
      if (key === 'transaction') return transaction
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { reader, counts }
}

test('IdentityService.resolveSession rejects an unknown token with one lookup and no transaction', async () => {
  const store = new SqliteServerStore(':memory:')
  const probe = countResolveReads(store)
  const identity = new IdentityService(probe.reader, new AdministratorDirectory(store.identity, [email]))
  try {
    assert.equal(await identity.resolveSession('unknown-synthetic-token'), null)
    assert.deepEqual(probe.counts, { transactions: 0, tokenHashQueries: 1, userQueries: 0 })
  } finally { store.close() }
})

for (const [name, token] of [['missing', undefined], ['empty', ''], ['overlong', 'x'.repeat(201)]] as const) {
  test(`IdentityService.resolveSession rejects a ${name} token without reads or transactions`, async () => {
    const store = new SqliteServerStore(':memory:')
    const probe = countResolveReads(store)
    const identity = new IdentityService(probe.reader, new AdministratorDirectory(store.identity, [email]))
    try {
      assert.equal(await identity.resolveSession(token), null)
      assert.deepEqual(probe.counts, { transactions: 0, tokenHashQueries: 0, userQueries: 0 })
    } finally { store.close() }
  })
}

for (const state of ['valid', 'idle-expired', 'absolute-expired', 'revoked'] as const) {
  test(`IdentityService.resolveSession counts real reads and transactions for a ${state} row`, async () => {
    const store = new SqliteServerStore(':memory:')
    let now = 0
    const administrators = new AdministratorDirectory(store.identity, [email])
    const clock = { now: () => new Date(now) }
    const policy = { idleMs: 100, absoluteMs: 1000, touchIntervalMs: 0, reauthenticateMs: 100 }
    const writer = new IdentityService(store, administrators, clock, policy)
    try {
      const user = await seedLocalAccount(store, { email, username: email, password })
      const issued = await writer.issue(user, 'resolve-count-test')
      if (state === 'idle-expired') now = 100
      if (state === 'absolute-expired') now = 1000
      if (state === 'revoked') await writer.revokeSession(user.id, issued.session.id)
      const probe = countResolveReads(store)
      const identity = new IdentityService(probe.reader, administrators, clock, policy)
      assert.deepEqual(await identity.resolveSession(issued.token), state === 'valid' ? issued.session : null)
      assert.deepEqual(probe.counts, {
        transactions: state === 'valid' ? 0 : 1,
        tokenHashQueries: state === 'valid' ? 1 : 2,
        userQueries: state === 'revoked' ? 0 : state === 'valid' ? 1 : 2,
      })
    } finally { store.close() }
  })
}

for (const transport of ['service', 'HTTP'] as const) {
  test(`IdentityService.resolveSession ${transport} renewal race performs exactly one recheck and returns the renewed row`, async () => {
    const app = createWemuxServer({ databasePath: ':memory:', administratorEmails: [email], mail: {}, google: {} })
    let now = 0
    const administrators = new AdministratorDirectory(app.store.identity, [email])
    const clock = { now: () => new Date(now) }
    const policy = { idleMs: 100, absoluteMs: 1000, touchIntervalMs: 0, reauthenticateMs: 100 }
    const writer = new IdentityService(app.store, administrators, clock, policy)
    const probe = countResolveReads(app.store)
    const pause = pauseFirstUserRead(probe.reader)
    let resolved: Awaited<ReturnType<IdentityService['resolveSession']>> = null
    let resolveCounts: typeof probe.counts | undefined
    class ObservedIdentity extends IdentityService {
      override async resolveSession(token: string | undefined) {
        resolved = await super.resolveSession(token)
        resolveCounts = { ...probe.counts }
        return resolved
      }
    }
    const identity = new ObservedIdentity(pause.reader, administrators, clock, policy)
    const streams = new SessionStreams(app.service)
    app.server.removeAllListeners('request')
    app.server.on('request', httpHandler({ identity, service: app.service, auth: new AuthenticationService(app.store, administrators), streams }))
    const origin = await app.listen(0)
    try {
      const user = await seedLocalAccount(app.store, { email, username: email, password })
      const issued = await writer.issue(user, 'counted-renewal-race')
      const request = transport === 'service'
        ? identity.resolveSession(issued.token)
        : fetch(origin + '/api/auth/sessions', { headers: { Cookie: `wemux_login_session=${issued.token}` } })
      await pause.waiting
      now = 90
      const renewed = await writer.touch(issued.session)
      assert.equal(Date.parse(renewed.idleExpiresAt), 190)
      now = 100
      pause.release()
      const result = await request
      assert.deepEqual(resolved, renewed)
      assert.deepEqual(resolveCounts, { transactions: 1, tokenHashQueries: 2, userQueries: 2 })
      if (result instanceof Response) {
        assert.equal(result.status, 200)
        assert.equal(result.headers.get('set-cookie'), null)
        assert.equal(result.headers.get('cache-control'), 'no-store')
        await result.json()
        assert.equal(Date.parse((await app.store.identity.getLoginSession(issued.session.id))!.idleExpiresAt), 200)
      } else {
        assert.deepEqual(result, renewed)
        assert.deepEqual(await app.store.identity.getLoginSession(issued.session.id), renewed)
      }
    } finally { pause.release(); streams.close(); await app.close() }
  })
}
