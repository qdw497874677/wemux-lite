import type { TeamId, UserId } from '@wemux/domain'
import { AppError } from '../../application/errors.js'
import { sendTeamInvitationMail } from '../../application/team-invitation-mail.js'
import type { RouteDescriptor } from './types.js'

const requireTeams = <T>(value: T | null | undefined): T => {
  if (!value) throw new AppError(404, 'Not found')
  return value
}

export const teamRoutes: readonly RouteDescriptor[] = [
  { method: 'GET', pattern: '/teams', auth: 'authenticated', handler: async context => context.json(200, { items: await requireTeams(context.teams).list(await context.actor()) }) },
  { method: 'POST', pattern: '/teams', auth: 'authenticated', handler: async context => context.json(201, await requireTeams(context.teams).create(await context.actor(), await context.readBody())) },
  { method: 'GET', pattern: '/team-invitations/:token', auth: 'authenticated', handler: async context => context.json(200, await requireTeams(context.teams).preview(context.params.token)) },
  { method: 'POST', pattern: '/team-invitations/:token/accept', auth: 'authenticated', handler: async context => context.json(200, await requireTeams(context.teams).accept(await context.actor(), context.params.token)) },
  { method: 'POST', pattern: '/teams/:teamId/ownership-transfer', auth: 'authenticated', handler: async context => context.json(200, await requireTeams(context.teams).transferOwnership(await context.actor(), context.params.teamId as TeamId, await context.readBody())) },
  { method: 'GET', pattern: '/teams/:teamId/members', auth: 'authenticated', handler: async context => context.json(200, { items: await requireTeams(context.teams).members(await context.actor(), context.params.teamId as TeamId) }) },
  { method: 'PATCH', pattern: '/teams/:teamId/members/:userId', auth: 'authenticated', handler: async context => context.json(200, await requireTeams(context.teams).updateMemberRole(await context.actor(), context.params.teamId as TeamId, context.params.userId as UserId, await context.readBody())) },
  { method: 'DELETE', pattern: '/teams/:teamId/members/:userId', auth: 'authenticated', handler: async context => { await requireTeams(context.teams).removeMember(await context.actor(), context.params.teamId as TeamId, context.params.userId as UserId); context.noContent() } },
  { method: 'GET', pattern: '/teams/:teamId/invitations', auth: 'authenticated', handler: async context => context.json(200, { items: await requireTeams(context.teams).invitations(await context.actor(), context.params.teamId as TeamId) }) },
  {
    method: 'POST', pattern: '/teams/:teamId/invitations', auth: 'authenticated', handler: async context => {
      const teams = requireTeams(context.teams), actor = await context.actor(), teamId = context.params.teamId as TeamId
      const invitation = await teams.invite(actor, teamId, await context.readBody())
      const team = (await teams.list(actor)).find(value => value.id === teamId)
      if (context.mail && team) await sendTeamInvitationMail(context.mail, { teamName: team.name, email: invitation.email, invitedBy: '团队管理员', token: invitation.token, existingAccount: invitation.existingAccount }).catch(async error => {
        await teams.revoke(actor, teamId, invitation.id)
        throw error
      })
      context.json(201, invitation)
    },
  },
  { method: 'DELETE', pattern: '/teams/:teamId/invitations/:invitationId', auth: 'authenticated', handler: async context => context.json(200, await requireTeams(context.teams).revoke(await context.actor(), context.params.teamId as TeamId, context.params.invitationId)) },
]
