import test from 'node:test'
import assert from 'node:assert/strict'
import { buildManagedAgentInstallCommand, managedAgentInstallIssues } from '../src/lib/agent-install.ts'

/**
 * 一键安装命令的生成规则必须与 Worker 安装脚本一致：私有地址绕代理、候选回退、
 * nc 传输不把半截脚本喂给 sh、所有部署相关值只走环境变量。
 */
test('single candidate command keeps the paste-able shape and passes every value as environment', () => {
  const { command, transport, candidates } = buildManagedAgentInstallCommand({
    serverUrl: 'https://wemux.example.com', agentKey: 'pi',
    installDir: '/srv/wemux-lite/agents/pi', workerHome: '/srv/wemux-lite',
  })
  assert.equal(transport, 'direct')
  assert.deepEqual(candidates, ['https://wemux.example.com'])
  assert.equal(command.split('\n').length, 2)
  assert.ok(command.startsWith("curl -fsSL --connect-timeout 5 'https://wemux.example.com/downloads/install-agent.sh' \\\n"))
  assert.ok(!command.includes('--noproxy'))
  assert.ok(command.endsWith("WEMUX_AGENT_KEY='pi' WEMUX_INSTALL_DIR='/srv/wemux-lite/agents/pi' WEMUX_WORKER_HOME='/srv/wemux-lite' sh"))
})

test('private, loopback and tailnet hosts bypass the global proxy; public hosts do not', () => {
  for (const host of ['http://192.168.1.10:8010', 'http://100.101.102.103:8010', 'http://127.0.0.1:8010', 'http://localhost:8010', 'http://worker.localhost']) {
    const { command } = buildManagedAgentInstallCommand({ serverUrl: host, agentKey: 'pi', installDir: '/home/u/.wemux-lite/agents/pi', workerHome: '/home/u/.wemux-lite' })
    assert.ok(command.includes(`--noproxy '${new URL(host).hostname}'`), host)
  }
  const { command } = buildManagedAgentInstallCommand({ serverUrl: 'https://agents.example.com', agentKey: 'pi', installDir: '/home/u/.wemux-lite/agents/pi', workerHome: '/home/u/.wemux-lite' })
  assert.ok(!command.includes('--noproxy'))
})

test('multiple candidates emit a fallback group and the preferred environment list', () => {
  const { command, candidates } = buildManagedAgentInstallCommand({
    serverUrl: 'http://100.101.102.103:8010', serverUrls: ['http://100.101.102.103:8010', 'http://192.168.1.10:8010'],
    agentKey: 'claude-code', installDir: '/home/u/.wemux-lite/agents/claude-code', workerHome: '/home/u/.wemux-lite',
  })
  assert.deepEqual(candidates, ['http://100.101.102.103:8010', 'http://192.168.1.10:8010'])
  assert.ok(command.startsWith("{ curl -fsSL --connect-timeout 5 'http://100.101.102.103:8010/downloads/install-agent.sh' --noproxy '100.101.102.103' \\\n"))
  assert.ok(command.includes("  || curl -fsSL --connect-timeout 5 'http://192.168.1.10:8010/downloads/install-agent.sh' --noproxy '192.168.1.10' ; } \\\n"), "回退组最后一行与 Worker 安装命令同形（与 apps/web/src/lib/worker-install.ts 一致）")
  assert.equal(command.split('\n').length, 3)
  assert.ok(!command.includes('WEMUX_SERVER_URL'))
})

test('nc transport downloads to a temporary file first and never pipes a partial script to sh', () => {
  const { command, transport } = buildManagedAgentInstallCommand({
    serverUrl: 'http://192.168.1.10:8010', agentKey: 'opencode', installDir: '/home/u/.wemux-lite/agents/opencode', workerHome: '/home/u/.wemux-lite', transport: 'nc',
  })
  assert.equal(transport, 'nc')
  assert.ok(command.startsWith('( d=$(mktemp -d) || exit 1\n'))
  assert.ok(command.includes('tailscale') || command.includes('node -e'))
  assert.ok(command.includes('/downloads/install-agent.sh'))
  assert.ok(command.endsWith('WEMUX_AGENT_KEY=\'opencode\' WEMUX_INSTALL_DIR=\'/home/u/.wemux-lite/agents/opencode\' WEMUX_WORKER_HOME=\'/home/u/.wemux-lite\' sh "$d/install.sh"\n)'))
  // https 候选无法走 nc 隧道时回退直连，绝不生成必败命令。
  const fallback = buildManagedAgentInstallCommand({ serverUrl: 'https://wemux.example.com', agentKey: 'pi', installDir: '/home/u/.wemux-lite/agents/pi', workerHome: '/home/u/.wemux-lite', transport: 'nc' })
  assert.equal(fallback.transport, 'direct')
})

test('paths and keys are quoted as data: no shell expansion escapes the environment variables', () => {
  const { command } = buildManagedAgentInstallCommand({
    serverUrl: 'http://192.168.1.10:8010', agentKey: 'pi',
    installDir: "/tmp/agents/pi' ; touch /tmp/wemux-pwned ; '", workerHome: '/tmp',
  })
  assert.ok(command.includes(`WEMUX_INSTALL_DIR='/tmp/agents/pi'"'"' ; touch /tmp/wemux-pwned ; '"'"''`))
  assert.ok(!command.includes("; touch /tmp/wemux-pwned ; ' sh"))
  // $HOME 是唯一允许远端展开的形式，其余一律单引号包裹。
  const home = buildManagedAgentInstallCommand({ serverUrl: 'http://192.168.1.10:8010', agentKey: 'pi', installDir: '$HOME/.wemux-lite/agents/pi', workerHome: '$HOME/.wemux-lite' })
  assert.ok(home.command.includes(`WEMUX_INSTALL_DIR="$HOME"'/.wemux-lite/agents/pi'`))
  assert.ok(home.command.includes(`WEMUX_WORKER_HOME="$HOME"'/.wemux-lite'`))
  assert.deepEqual(home.issues, [])
})

test('external install directories need the explicit opt-in flag, exactly like the served script', () => {
  const outside = buildManagedAgentInstallCommand({ serverUrl: 'http://192.168.1.10:8010', agentKey: 'pi', installDir: '/opt/wemux-agents/pi', workerHome: '/home/u/.wemux-lite' })
  assert.equal(outside.command, '')
  assert.deepEqual(outside.issues.map(issue => issue.code), ['install_dir_outside_worker_home'])
  const allowed = buildManagedAgentInstallCommand({ serverUrl: 'http://192.168.1.10:8010', agentKey: 'pi', installDir: '/opt/wemux-agents/pi', workerHome: '/home/u/.wemux-lite', allowExternalInstallDir: true })
  assert.deepEqual(allowed.issues, [])
  assert.ok(allowed.command.includes("WEMUX_ALLOW_EXTERNAL_INSTALL_DIR='yes'"))
})

test('invalid input is reported as issues instead of throwing or rendering a broken command', () => {
  assert.deepEqual(managedAgentInstallIssues({ serverUrl: 'not a url', agentKey: 'pi', installDir: '/a', workerHome: '/a' }).map(issue => issue.code), ['server_url_invalid'])
  assert.deepEqual(managedAgentInstallIssues({ serverUrl: '', agentKey: 'pi', installDir: '/a', workerHome: '/a' }).map(issue => issue.code), ['server_url_invalid'])
  assert.deepEqual(managedAgentInstallIssues({ serverUrl: 'http://127.0.0.1:8010', agentKey: 'codex', installDir: '/a/b', workerHome: '/a', agentKeys: ['pi', 'opencode', 'claude-code'] }).map(issue => issue.code), ['agent_key_unsupported'])
  assert.deepEqual(managedAgentInstallIssues({ serverUrl: 'http://127.0.0.1:8010', agentKey: 'pi', installDir: 'agents/pi', workerHome: '/a' }).map(issue => issue.code), ['install_dir_not_absolute'])
  assert.deepEqual(managedAgentInstallIssues({ serverUrl: 'http://127.0.0.1:8010', agentKey: 'pi', installDir: '/a/agents/pi', workerHome: 'relative' }).map(issue => issue.code), ['worker_home_not_absolute'])
  assert.deepEqual(managedAgentInstallIssues({ serverUrl: 'http://127.0.0.1:8010', agentKey: 'pi', installDir: '', workerHome: '/a' }).map(issue => issue.code), ['install_dir_required'])
  assert.deepEqual(managedAgentInstallIssues({ serverUrl: 'http://127.0.0.1:8010', agentKey: 'pi', installDir: '/a', workerHome: '/a' }).map(issue => issue.code), [])
  const empty = buildManagedAgentInstallCommand({ serverUrl: 'http://127.0.0.1:8010', agentKey: '', installDir: '', workerHome: '' })
  assert.equal(empty.command, '')
  assert.equal(empty.issues.length, 3)
  // 候选里的坏地址（例如未加方括号的 IPv6）只被剔除，不能让渲染崩溃。
  const filtered = buildManagedAgentInstallCommand({ serverUrl: 'http://127.0.0.1:8010', serverUrls: ['fe80::1:8010', 'http://127.0.0.1:8010'], agentKey: 'pi', installDir: '/a/b', workerHome: '/a' })
  assert.deepEqual(filtered.candidates, ['http://127.0.0.1:8010'])
  assert.ok(filtered.command.includes('127.0.0.1'))
})
