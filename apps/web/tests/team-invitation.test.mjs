import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../src/', import.meta.url)
const read = name => readFile(new URL(name, root), 'utf8')

test('团队邀请页支持登录或以锁定邮箱注册', async () => {
  const source = await read('components/team-invitation.tsx')
  assert.match(source, /api\.invitation\(token\)/)
  assert.match(source, /api\.acceptInvitation\(token\)/)
  assert.match(source, /mode="login"/)
  assert.match(source, /mode="register"/)
  assert.match(source, /invitation=\{\{ email: invitation\.email, token \}\}/)
  assert.doesNotMatch(source, /crypto\.randomUUID/)
})

test('注册表单在邀请上下文锁定邮箱并传递一次性令牌', async () => {
  const source = await read('components/auth-form.tsx')
  assert.match(source, /readOnly=\{Boolean\(invitation\)\}/)
  assert.match(source, /invitationToken: invitation\?\.token/)
  assert.match(source, /useState\(invitation\?\.email \?\? ''\)/)
})

test('团队管理页包含创建、邀请、成员与待处理邀请能力', async () => {
  const source = await read('components/team-page.tsx')
  assert.match(source, /api\.createTeam/)
  assert.match(source, /api\.inviteTeamMember/)
  assert.match(source, /api\.updateTeamMemberRole/)
  assert.match(source, /api\.removeTeamMember/)
  assert.match(source, /api\.transferTeamOwnership/)
  assert.match(source, /访问权限立即失效/)
  assert.match(source, /停止命令可能仍在等待 Worker 上线送达/)
  assert.match(source, /api\.teamMembers/)
  assert.match(source, /api\.teamInvitations/)
  assert.match(source, /创建团队/)
  assert.match(source, /邀请成员/)
  assert.match(source, /onBack: \(\) => void/)
  assert.match(source, /返回项目/)
  assert.match(source, /ArrowLeft/)
})

test('join 与 teams 是正式 Web 路由并进入对应页面', async () => {
  const [app, router] = await Promise.all([read('App.tsx'), read('app/router.tsx')])
  assert.match(app, /<TeamInvitationScreen/)
  assert.match(app, /<TeamPage api=\{api\}/)
  assert.match(router, /'\/join'/)
  assert.match(router, /'\/teams'/)
})
