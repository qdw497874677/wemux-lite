import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSelection } from '../src/app/selection.ts'
const projects = [{ id: 'p' }, { id: 'other' }]
const workspaces = [{ id: 'w', projectId: 'p' }]
const sessions = [{ id: 's', projectId: 'p', workspaceId: 'w', canRead: true }]
const resolve = (path, search = '') => resolveSelection(path, search, projects, workspaces, sessions)
test('legacy session deep link infers parents and replaces with canonical URL', () => {
  assert.deepEqual(resolve('/', '?session=s'), { redirect: '/projects/p/sessions/s' })
  assert.deepEqual(resolve('/', '?workspace=w'), { redirect: '/projects/p/workspaces/w' })
})
test('project-root query selection resolves to a canonical resource without dropping it', () => {
  assert.deepEqual(resolve('/projects/p', '?session=s'), { redirect: '/projects/p/sessions/s' })
  assert.deepEqual(resolve('/projects/p', '?workspace=w'), { redirect: '/projects/p/workspaces/w' })
  assert.deepEqual(resolve('/projects/p', '?session=s&view=canvas'), { redirect: '/projects/p/overview?view=canvas&session=s' })
  assert.match(resolve('/projects/other', '?session=s').error, /不属于/)
  assert.match(resolve('/projects/p', '?session=missing').error, /不存在/)
  assert.match(resolve('/projects/p', '?project=other&session=s').error, /冲突/)
  assert.match(resolveSelection('/projects/p', '?session=s', projects, workspaces, [{ ...sessions[0], canRead: false }]).error, /无权限/)
})

test('canonical refresh preserves resource and rejects conflicting query input', () => {
  assert.deepEqual(resolve('/projects/p/sessions/s'), {})
  assert.match(resolve('/projects/p/sessions/s', '?session=other').error, /冲突/)
})
test('unknown, inaccessible and cross-project resources never select first item', () => {
  assert.match(resolve('/projects/p/sessions/missing').error, /不存在/)
  assert.match(resolve('/projects/other/sessions/s').error, /不属于/)
  assert.match(resolve('/projects/other/workspaces/w').error, /不属于/)
  assert.match(resolveSelection('/', '?session=s', projects, workspaces, [{ ...sessions[0], canRead: false }]).error, /无权限/)
})

test('Skill Studio accepts its project route and rejects nested paths', () => {
  assert.deepEqual(resolve('/projects/p/skills'), {})
  assert.ok(resolve('/projects/p/skills/extra').error)
})

test('invalid sections, extra segments and malformed URI are rejected; indexes replace', () => {
  for (const path of ['/projects/p/nonsense', '/projects/p/overview/extra', '/runtime/extra', '/projects/%ZZ']) assert.ok(resolve(path).error)
  assert.deepEqual(resolve('/'), { redirect: '/projects' })
  assert.deepEqual(resolve('/projects/p'), { redirect: '/projects/p/overview' })
})
