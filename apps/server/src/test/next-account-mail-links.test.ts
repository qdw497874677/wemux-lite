import test from 'node:test'
import assert from 'node:assert/strict'
import { nextConsoleLink, verificationLink, passwordResetLink, changeEmailLink } from '../application/mail/email-delivery.ts'
import { sendTeamInvitationMail } from '../application/team-invitation-mail.ts'

test('Next mail links preserve configured origin and exact legacy one-use challenge', () => {
  for (const make of [verificationLink, passwordResetLink, changeEmailLink]) {
    const legacy = new URL(make('https://configured.example.test/', 'synthetic/+challenge'))
    const next = new URL(nextConsoleLink(legacy.href))
    assert.equal(next.origin, legacy.origin)
    assert.equal(next.pathname, `/next${legacy.pathname}`)
    assert.equal(next.search, legacy.search)
    assert.equal(next.searchParams.get('token'), 'synthetic/+challenge')
  }
})
test('invitation mail retains original entry and labels Next entry for same token and recipient', async () => {
  let delivered: { to: string; text: string } | undefined
  await sendTeamInvitationMail({ from: { address: 'sender@example.test', name: 'Wemux' }, publicUrl: 'https://configured.example.test', outboxDir: null, delivery: { kind: 'outbox', deliver: async mail => { delivered = mail } } }, { teamName: 'Synthetic team', email: 'member@example.test', invitedBy: '团队管理员', token: 'synthetic-token', existingAccount: true })
  assert.equal(delivered?.to, 'member@example.test')
  assert.match(delivered!.text, /登录并接受邀请：https:\/\/configured.example.test\/join\?token=synthetic-token/)
  assert.match(delivered!.text, /在新版中打开：https:\/\/configured.example.test\/next\/join\?token=synthetic-token/)
})
