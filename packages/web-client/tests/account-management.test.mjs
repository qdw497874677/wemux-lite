import test from 'node:test'
import assert from 'node:assert/strict'
import { createClusterClient } from '@wemux/web-client'
const session = { teamId: '', csrfToken: 'test-csrf', username: 'test', email: null, instanceAdministrator: false }
function fixture() {
  const calls = []
  const api = createClusterClient(session, () => {}, { origin: 'http://127.0.0.1', fetcher: async (url, init) => {
    calls.push({ path: url.pathname, query: url.search, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, csrf: init.headers['X-CSRF-Token'], credentials: init.credentials })
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    return Response.json(url.pathname === '/api/auth/email/verify' ? { csrfToken: 'verified-csrf' } : { items: [], revoked: 2 })
  } })
  return { api, calls }
}
test('account operations retain public routes and verification adopts CSRF', async () => {
  const { api, calls } = fixture()
  await api.register({ email: 'test@example.test', displayName: 'Test', password: 'synthetic password', invitationToken: 'invitation' })
  await api.resendVerification('test@example.test'); await api.forgotPassword('test@example.test')
  await api.resetPassword('challenge', 'new synthetic password'); await api.confirmEmailChange('challenge')
  await api.verifyEmail('challenge'); await api.changePassword({ newPassword: 'password' })
  assert.deepEqual(calls.map(call => call.path), ['/api/auth/register','/api/auth/register/resend','/api/auth/password/forgot','/api/auth/password/reset','/api/auth/email/change/confirm','/api/auth/email/verify','/api/auth/password/change'])
  assert.equal(calls.at(-1).csrf, 'verified-csrf')
  assert.ok(calls.every(call => call.credentials === 'same-origin'))
  api.dispose()
})
test('team membership writes encode ids and preserve server role and ownership contracts', async () => {
  const { api, calls } = fixture()
  await api.createTeam('Team'); await api.teamMembers('a/b'); await api.updateTeamMemberRole('a/b','u/v','admin')
  await api.transferTeamOwnership('a/b','u/v','Team'); await api.removeTeamMember('a/b','u/v')
  await api.inviteTeamMember('a/b','member@example.test'); await api.revokeTeamInvitation('a/b','i/j'); await api.acceptInvitation('t/x')
  assert.equal(calls[1].path, '/api/teams/a%2Fb/members')
  assert.deepEqual(calls[2].body, { role: 'admin' }); assert.equal(calls[2].method, 'PATCH')
  assert.deepEqual(calls[3].body, { userId: 'u/v', confirmation: 'Team' })
  assert.equal(calls[4].method, 'DELETE'); assert.equal(calls[6].path, '/api/teams/a%2Fb/invitations/i%2Fj')
  assert.equal(calls[7].path, '/api/team-invitations/t%2Fx/accept')
  assert.ok(calls.filter(call => call.method !== 'GET').every(call => call.csrf === 'test-csrf'))
  api.dispose()
})
test('logout-other-devices preserves current CSRF; PAT and lifecycle writes use shared protection', async () => {
  const { api, calls } = fixture()
  await api.logoutAll(); await api.createPersonalAccessToken({ name: 'test', scopes: ['read'], expiresAt: '2030-01-01' })
  await api.rotatePersonalAccessToken('t/x', '2030-01-02'); await api.revokePersonalAccessToken('t/x')
  await api.confirmAccountDeletion('删除我的账号'); await api.manageAccount('u/x', 'disable')
  await api.setRegistrationPolicy('invite_only'); await api.unbindLoginMethod('g/x', { currentPassword: 'synthetic password' })
  assert.ok(calls.every(call => call.csrf === 'test-csrf'))
  assert.equal(calls[2].path, '/api/auth/personal-access-tokens/t%2Fx/rotate')
  assert.equal(calls[4].body.action, 'confirm-deletion')
  assert.equal(calls[5].path, '/api/auth/account/users/u%2Fx/disable')
  assert.equal(calls[7].method, 'DELETE')
  assert.equal(api.auditExportUrl({ action: 'account.disabled', limit: 2, cursor: 'private' }), '/api/auth/account/audit/export?action=account.disabled')
  api.dispose()
})
test('Google login and link use explicit Next return targets without credential forwarding', async () => {
  const { api, calls } = fixture()
  await api.startGoogleSignIn('/next/teams'); await api.startGoogleLink('/next/settings')
  assert.deepEqual(calls.map(call => [call.path, call.body]), [['/api/auth/oauth/google/start', { returnTo: '/next/teams' }], ['/api/auth/identities/google/start', { returnTo: '/next/settings' }]])
  api.dispose()
})
