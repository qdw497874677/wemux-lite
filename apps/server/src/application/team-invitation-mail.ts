import type { MailSettings } from './mail/email-delivery.ts'

export interface TeamInvitationMailInput {
  readonly teamName: string
  readonly email: string
  readonly invitedBy: string
  readonly token: string
  readonly existingAccount: boolean
}

export async function sendTeamInvitationMail(mail: MailSettings, input: TeamInvitationMailInput): Promise<void> {
  const path = `/join?token=${encodeURIComponent(input.token)}`
  const action = input.existingAccount ? '登录并接受邀请' : '注册并加入团队'
  await mail.delivery.deliver({
    to: input.email,
    subject: `加入 ${input.teamName}`,
    text: [
      `${input.invitedBy} 邀请你加入 Wemux 团队「${input.teamName}」。`,
      '',
      `${action}：${mail.publicUrl}${path}`,
      '',
      '邀请将在 7 天后过期。若你未预期收到此邮件，可以忽略。',
    ].join('\n'),
  })
}
