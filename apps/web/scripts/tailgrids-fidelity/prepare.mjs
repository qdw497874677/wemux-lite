// 准备保真工装的两份「运行时生成」输入（都不入库）：
//
//   1. playground/src/up-core/*.tsx   上游 TailGrids registry/core 源码（MIT），
//      逐字复制，只把 `@/utils/cn` 改成同目录可解析的 `../utils/cn`；
//   2. playground/src/wemux-styles.css 当前 wemux 样式表副本，
//      我们这一侧就按它渲染，保证比对的是仓库里的真实样式。
//
// 用法：
//   WEMUX_TAILGRIDS_SRC=/path/to/tailgrids node apps/web/scripts/tailgrids-fidelity/prepare.mjs
//
// 上游检出：git clone https://github.com/TailGrids/tailgrids，
// 这里只读它的 apps/docs/src/registry/core（免费核心组件）与 HEAD commit 作为追溯依据。
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const upstreamRoot = process.env.WEMUX_TAILGRIDS_SRC ?? '/tmp/tg/src-repo'
const REF = 'apps/docs/src/registry/core'
const coreDir = join(upstreamRoot, REF)
const outDir = join(here, 'playground/src/up-core')
const oursStyles = join(repoRoot, 'apps/web/src/styles.css')
const oursStylesOut = join(here, 'playground/src/wemux-styles.css')

if (!existsSync(coreDir)) {
  console.error(`找不到上游源码：${coreDir}
请先 clone TailGrids 仓库，并用 WEMUX_TAILGRIDS_SRC 指向它：
  git clone --depth 1 https://github.com/TailGrids/tailgrids /tmp/tg/src-repo
  WEMUX_TAILGRIDS_SRC=/tmp/tg/src-repo node apps/web/scripts/tailgrids-fidelity/prepare.mjs`)
  process.exit(1)
}

let commit = 'unknown'
try {
  commit = execFileSync('git', ['-C', upstreamRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
} catch {
  // 不是 git 检出（例如解压的 tarball）也能跑，只是追溯信息缺失
}

mkdirSync(outDir, { recursive: true })
let copied = 0
/** 上游把少数组件放在子目录里（spinner/default.tsx、spinner/dotted.tsx、combobox/*），
 *  一并按原目录结构复制；cn 的相对路径按子目录深度修正。 */
const copyCore = (dir, depth = 0) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      copyCore(join(dir, entry.name), depth + 1)
      continue
    }
    if (!entry.name.endsWith('.tsx')) continue
    const source = readFileSync(join(dir, entry.name), 'utf8')
    const cnPath = '../'.repeat(depth + 1) + 'utils/cn'
    const patched = source.replaceAll('from "@/utils/cn"', `from "${cnPath}"`)
    const target = join(outDir, relative(coreDir, join(dir, entry.name)))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, patched)
    copied += 1
  }
}
copyCore(coreDir)

cpSync(oursStyles, oursStylesOut)

console.log(`上游源码：${coreDir}`)
console.log(`上游 commit：${commit}`)
console.log(`生成 ${copied} 个文件 -> playground/src/up-core/`)
console.log(`复制我们的样式表 -> playground/src/wemux-styles.css`)