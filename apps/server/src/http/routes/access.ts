import type { RequestAccess } from '../../application/auth.ts'

/** PAT scope 是请求能力上限，资源 Grant 仍在服务层继续取交集。 */
export function requiredPatAccess(path: string, method: string | undefined): RequestAccess {
  if (method === 'GET' || method === 'HEAD') return 'read'
  if (/^\/sessions\/[^/]+\/(messages|turn\/stop|runtime\/commands|runtime\/approvals\/)/.test(path)
    || /\/tasks\/[^/]+\/(launch|runs\/[^/]+\/cancel)$/.test(path)
    || method === 'POST' && (path === '/sessions' || /\/session-forks$/.test(path))) return 'execute'
  if (/^\/teams\/[^/]+\/(members\/|ownership-transfer|invitations(?:\/|$))/.test(path)
    || /^\/(projects|workers|sessions)\/[^/]+\/(access|grants)(?:\/|$)/.test(path)
    || /^\/workers\/[^/]+\/revoke$/.test(path)
    || path === '/bootstrap' || path === '/enrollment-tokens' || /\/capability-assets$/.test(path)) return 'admin'
  return 'write'
}
