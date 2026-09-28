import { resolve } from 'node:path'
import { SqliteServerStore } from './storage/sqlite/store.ts'
import { AccountRecovery } from './application/recovery.ts'
import { AdministratorDirectory, parseAdministratorEmails } from './application/administrator-directory.ts'
import { AppError } from './application/errors.ts'

/**
 * Server 主机本地管理入口（Ticket 04 验收项 6）。
 *
 * 这里没有任何网络代码：恢复能力只在本机进程内可用，且不注册 HTTP 路由，
 * 因此"丢失管理员凭据"不会重新打开公网提权入口，也不会绕过 CSRF/Cookie 会话。
 * 实例管理员由启动配置的 WEMUX_ADMIN_EMAILS 声明；本命令不代替声明，只补上归属与审计。
 *
 * 用法（在 Server 所在主机执行）：
 *   node dist/cli.js credentials list
 *   node dist/cli.js credentials reset-password --username owner@example.com [--password <新密码>] [--keep-tokens]
 *   node dist/cli.js credentials revoke --username owner@example.com [--tokens]
 * 数据库路径取 `--database`，否则回落到 `WEMUX_DATABASE_PATH`，再回落到 `./data/server.sqlite`。
 */
const usage = `用法：
  wemux-server credentials list
  wemux-server credentials reset-password --username <登录名> [--password <新密码>] [--keep-tokens]
  wemux-server credentials revoke --username <登录名> [--tokens]

选项：
  --database <path>   数据库文件路径（默认 WEMUX_DATABASE_PATH，再默认 ./data/server.sqlite）
  --keep-tokens       重置密码时保留 PAT（默认连同 PAT 一起撤销）
  --tokens            撤销凭据时同时撤销 PAT（默认只撤销浏览器会话）
  --json              机器可读输出（默认，便于脚本对账）`

const readFlags = (argv: readonly string[]): Map<string, string | true> => {
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!
    if (!value.startsWith('--')) throw new AppError(400, `无法识别的参数 ${value}`, 'cli_argument')
    const name = value.slice(2)
    const next = argv[index + 1]
    if (name === 'keep-tokens' || name === 'tokens' || name === 'json') { flags.set(name, true); continue }
    if (next === undefined || next.startsWith('--')) throw new AppError(400, `${value} 需要一个值`, 'cli_argument')
    flags.set(name, next)
    index += 1
  }
  return flags
}

const required = (flags: Map<string, string | true>, name: string): string => {
  const value = flags.get(name)
  if (typeof value !== 'string' || value.trim() === '') throw new AppError(400, `缺少 --${name}`, 'cli_argument')
  return value
}

const main = async (argv: readonly string[]): Promise<number> => {
  const [command, action, ...rest] = argv
  if (command !== 'credentials') { console.error(usage); return command === undefined || command === 'help' || command === '--help' ? 0 : 1 }
  const flags = readFlags(rest)
  const databasePath = resolve(typeof flags.get('database') === 'string' ? flags.get('database') as string : process.env.WEMUX_DATABASE_PATH ?? './data/server.sqlite')
  const store = new SqliteServerStore(databasePath)
  try {
    const recovery = new AccountRecovery(store, new AdministratorDirectory(store.identity, parseAdministratorEmails(process.env.WEMUX_ADMIN_EMAILS)))
    if (action === 'list') {
      const accounts = await recovery.accounts()
      console.log(JSON.stringify({ databasePath, accounts }, null, 2))
      if (accounts.length === 0) console.error('实例还没有任何账号；请先设置 WEMUX_ADMIN_EMAILS 并在 Web 完成该邮箱的注册。')
      return 0
    }
    if (action === 'reset-password') {
      const report = await recovery.resetPassword({ login: required(flags, 'username'), password: typeof flags.get('password') === 'string' ? flags.get('password') as string : undefined, keepTokens: flags.get('keep-tokens') === true })
      // 明文密码只在这个进程的 stdout 出现一次：不写文件、不写审计、不写日志。
      console.log(JSON.stringify({ ...report, password: report.password }, null, 2))
      console.error(`已重置 ${report.login} 的本机密码，并撤销 ${report.revokedSessions} 个会话与 ${report.revokedTokens} 个 PAT。请立即用新密码登录并妥善保存，本终端之后无法再次显示。`)
      return 0
    }
    if (action === 'revoke') {
      console.log(JSON.stringify(await recovery.revokeCredentials({ login: required(flags, 'username'), tokens: flags.get('tokens') === true }), null, 2))
      return 0
    }
    console.error(usage)
    return 1
  } finally {
    store.close()
  }
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  // 恢复失败必须是显式失败：打印可诊断错误，但绝不回显密码或令牌。
  console.error(error instanceof AppError ? `${error.code}: ${error.message}` : error)
  process.exitCode = 1
}