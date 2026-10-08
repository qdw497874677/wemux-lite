import assert from 'node:assert/strict'
import { readFile, glob } from 'node:fs/promises'
import test from 'node:test'

// crypto.randomUUID 只在安全上下文（HTTPS/localhost）可用；通过局域网或
// Tailscale IP 的 HTTP 访问（不安全上下文）没有它，任何直接调用都会让交互静默失败。
// 回归契约：业务代码只允许通过 lib/random.ts 的 randomId() 生成 UUID。
test('web src must not call crypto.randomUUID directly (insecure-context safety)', async () => {
  const legacy = await readFile(new URL('../src/lib/random.ts', import.meta.url), 'utf8')
  assert.match(legacy, /export \{ randomId \} from '@wemux\/web-client'/)
  const random = await readFile(new URL('../../../packages/web-client/src/random.ts', import.meta.url), 'utf8')
  assert.match(random, /export function randomId\(\): string/)
  assert.match(random, /typeof crypto\.randomUUID === 'function'/)
  assert.match(random, /crypto\.getRandomValues/)

  const files = [...await Array.fromAsync(glob(new URL('../src/**/*.ts*', import.meta.url).pathname)), ...await Array.fromAsync(glob(new URL('../../../packages/web-client/src/**/*.ts', import.meta.url).pathname))]
  const offenders = []
  for (const file of files) {
    if (file.endsWith('/web-client/src/random.ts')) continue
    const source = await readFile(file, 'utf8')
    if (source.includes('crypto.randomUUID')) offenders.push(file)
  }
  assert.deepEqual(offenders, [], '这些文件直接调用了 crypto.randomUUID，需改用 lib/random.ts 的 randomId()')
})

// 非安全上下文（HTTP 局域网/Tailscale 访问）下：
// - navigator.clipboard 不存在；
// - 现代 Chromium 会静默忽略 document.execCommand('copy') 却仍返回 true（假成功）；
// 因此剪贴板写入失败时必须降级为「全选命令 + 引导用户 Ctrl+C / 长按复制」。
test('clipboard must degrade to manual-copy on insecure contexts (no execCommand lies)', async () => {
  const legacy = await readFile(new URL('../src/lib/utils.ts', import.meta.url), 'utf8')
  assert.match(legacy, /export \{ copyText, selectElementText \} from '@wemux\/web-client'/)
  const utils = await readFile(new URL('../../../packages/web-client/src/clipboard.ts', import.meta.url), 'utf8')
  for (const pattern of ['../src/**/*.ts*', '../../../packages/web-client/src/**/*.ts']) {
    for await (const file of glob(new URL(pattern, import.meta.url).pathname)) {
      assert.doesNotMatch(await readFile(file, 'utf8'), /document\.execCommand/, file)
    }
  }
  assert.match(utils, /if \(!\(navigator\.clipboard && window\.isSecureContext\)\) return false/)
  assert.doesNotMatch(utils, /document\.execCommand/, 'execCommand 在非安全上下文假成功，禁止再用作剪贴板兑底')
  assert.match(utils, /export function selectElementText\(element: HTMLElement\): void/)

  const dialog = await readFile(new URL('../src/components/worker-enrollment-dialog.tsx', import.meta.url), 'utf8')
  assert.match(dialog, /selectElementText/, '复制失败时必须全选命令进入手动模式')
  assert.match(dialog, /已全选，请 Ctrl\+C \/ 长按复制/, '按钮文案必须引导手动复制')
  assert.match(dialog, /selectCommandManually/, '命令区域点击应可重新全选')
})
