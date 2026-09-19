/**
 * Web 控制台（SPA）拥有的 `/auth/*` 路由。
 *
 * 这些页面由前端渲染，服务端只负责把它们交给 index.html 回退。它们和 `/auth/*` 下的 API 路径
 * （如 Google OAuth 回调、`/auth/register` POST）共用一个前缀，所以 HTTP 层必须显式区分：
 * 曾因为「`/auth/` 一律当 API 命名空间」把邮件里的确认页和重置页挡成 401 JSON。
 *
 * 邮件链接就是按这里生成（见 `mail/email-delivery.ts`），改动必须与
 * `apps/web/src/app/router.tsx` 的 `paths` 保持同步。
 */
export const WEB_CONSOLE_AUTH_PATHS = { verifyEmail: '/auth/verify-email', passwordReset: '/auth/password/reset' } as const

const webConsoleAuthPaths: ReadonlySet<string> = new Set(Object.values(WEB_CONSOLE_AUTH_PATHS))

/** 该路径是否由 Web 控制台渲染（需要 SPA 回退），而不是服务端 API 路由。 */
export function isWebConsoleAuthPath(path: string): boolean {
  return webConsoleAuthPaths.has(path)
}