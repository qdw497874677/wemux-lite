import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

// C0 架构合同（Ticket 16）：画布模块依赖门。领域/应用/宿主契约不得依赖渲染器；
// React Flow 只能出现在唯一适配器目录；Web 不得引用 Server/Worker 内部源码。
// 这些是回归契约：实现画布 UI 时不允许把渲染器类型渗透到下层。

const repoRoot = new URL('../../../', import.meta.url)

async function walk(relativeDir) {
  const entries = await readdir(new URL(relativeDir, repoRoot), { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const files = []
  for (const entry of entries) {
    const next = `${relativeDir.replace(/\/$/, '')}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      files.push(...await walk(next))
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.test\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      files.push(next)
    }
  }
  return files
}

/** 只统计真实 import 说明符：设计文档和注释可以提到包名。 */
function importedSpecifiers(source) {
  const specifiers = new Set()
  for (const pattern of [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }
  return specifiers
}

const isReactFlow = specifier => specifier === '@xyflow/react' || specifier.startsWith('@xyflow/react/')

/** 返回违反规则的文件与说明符，供断言输出可复现证据。 */
async function violations(dirs, predicate) {
  const found = []
  for (const file of (await Promise.all(dirs.map(walk))).flat()) {
    const specifiers = importedSpecifiers(await readFile(new URL(file, repoRoot), 'utf8'))
    for (const specifier of specifiers) if (predicate(specifier, file)) found.push(`${file} imports ${specifier}`)
  }
  return found
}

const REACT_FLOW_ADAPTER_DIR = 'apps/web/src/features/session-canvas/adapters/react-flow/'
const AI_ELEMENTS_DIR = 'apps/web/src/components/ai-elements/'
const AI_ELEMENTS_WORKFLOW_FILES = new Set(['canvas.tsx', 'connection.tsx', 'controls.tsx', 'edge.tsx', 'node.tsx', 'panel.tsx', 'toolbar.tsx'].map(file => `${AI_ELEMENTS_DIR}${file}`))

test('renderer isolation: @xyflow/react stays in the canvas adapter and AI Elements workflow primitives', async () => {
  const found = await violations(
    ['apps/web/src', 'packages/domain/src', 'packages/server-domain/src', 'packages/web-contract/src', 'apps/server/src', 'apps/worker/src'],
    (specifier, file) => isReactFlow(specifier) && !file.startsWith(REACT_FLOW_ADAPTER_DIR) && !AI_ELEMENTS_WORKFLOW_FILES.has(file),
  )
  assert.deepEqual(found, [], '@xyflow/react 只允许出现在会话画布适配器与 AI Elements workflow 语义组件；领域与应用层必须使用渲染器无关的画布读模型')
})

test('canvas model and application layers stay renderer-free', async () => {
  const found = await violations(
    ['apps/web/src/features/session-canvas/model', 'apps/web/src/features/session-canvas/application'],
    specifier => isReactFlow(specifier) || specifier.includes('adapters/react-flow'),
  )
  assert.deepEqual(found, [], '画布 model/application 层不得依赖 React Flow 适配器；渲染器类型只允许在 adapters/react-flow 内翻译')
})

test('@wemux/domain stays a leaf package: no web-contract import', async () => {
  const found = await violations(['packages/domain/src'], specifier => specifier === '@wemux/web-contract' || specifier.startsWith('@wemux/web-contract/'))
  assert.deepEqual(found, [], '@wemux/domain 不得 import web-contract，否则 lineage/canvas 契约继承包循环')
})

test('web features reach Server and Worker only through wire contracts', async () => {
  const found = await violations(
    ['apps/web/src'],
    specifier => ['@wemux/server', '@wemux/worker'].some(pkg => specifier === pkg || specifier.startsWith(`${pkg}/`)),
  )
  assert.deepEqual(found, [], 'Web 只能通过 HTTP/WS 契约访问 Server 与 Worker，禁止直接 import 其内部源码')
})

test('agent adapters carry runtime differences only', async () => {
  const found = await violations(
    ['apps/worker/src/agents'],
    specifier => specifier.includes('server-domain') || specifier.includes('/http/') || specifier.includes('/transport/')
      || specifier.endsWith('/access.js') || specifier.endsWith('/authorization.js'),
  )
  assert.deepEqual(found, [], 'Agent Adapter 不得读取 Grant、处理重连或进入 HTTP/transport 层')
})

test('canvas read model has no single dependency on the renderer path', async () => {
  // 画布不得成为访问 Session 的唯一通道：读模型与 Session Surface 必须独立于渲染器存在。
  const domainGraph = await readFile(new URL('packages/domain/src/session-graph.ts', repoRoot), 'utf8')
  assert.ok(!isReactFlow('@xyflow/react') || !/from ['"]@xyflow\/react/.test(domainGraph))
  const webContract = await readFile(new URL('packages/web-contract/src/session-graph.ts', repoRoot), 'utf8')
  assert.deepEqual(
    [...importedSpecifiers(webContract)].filter(isReactFlow),
    [],
    'web-contract 的图 DTO 不得引用 React Flow 类型',
  )
})

test('exactly one session submission controller and one composer exist', async () => {
  // Server Web 与未来 Worker Web 必须复用同一 Session Surface，不得各自新增
  // Composer、Journal、Queue 或控制状态机；新增只能通过加深现有 Module。
  const declarations = []
  for (const file of await walk('apps/web/src')) {
    const source = await readFile(new URL(file, repoRoot), 'utf8')
    for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+(Composer|SubmissionController)\b/g)) {
      declarations.push(`${match[1]} @ ${file}`)
    }
  }
  assert.deepEqual(
    declarations.sort(),
    ['Composer @ apps/web/src/features/sessions/conversation.tsx', 'SubmissionController @ apps/web/src/features/sessions/submission.ts'],
    '会话提交状态机与 Composer 必须唯一存在于 features/sessions；宿主差异只能通过 Host Adapter 组合，不得复制第二套',
  )
})