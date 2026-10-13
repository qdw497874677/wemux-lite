// 浏览器测试共用环境契约（对齐 apps/web-next/tests/acceptance-runtime.mjs）：
//   PLAYWRIGHT_CORE_PATH      playwright-core/index.mjs 的绝对路径
//   PLAYWRIGHT_CHROMIUM_PATH  Chromium 可执行文件的绝对路径
// env 缺失或不可用时抛出可读错误，而不是静态 import 触发模块解析崩溃。
// 本机示例：
//   PLAYWRIGHT_CORE_PATH=/home/qdw/.cache/wemux-pw/node_modules/playwright-core/index.mjs
//   PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium
import { accessSync, constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

const usage = '请设置 PLAYWRIGHT_CORE_PATH（playwright-core/index.mjs 绝对路径）与 PLAYWRIGHT_CHROMIUM_PATH（Chromium 可执行文件绝对路径）后重跑'

function readable(path, flag, description) {
  try {
    accessSync(path, flag)
    return true
  } catch {
    return false
  }
}

export function browserLaunchEnv() {
  const problems = []
  const module = process.env.PLAYWRIGHT_CORE_PATH
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
  if (!module) problems.push('缺少 PLAYWRIGHT_CORE_PATH')
  else if (!isAbsolute(module)) problems.push(`PLAYWRIGHT_CORE_PATH 不是绝对路径：${module}`)
  else if (!readable(module, constants.R_OK)) problems.push(`PLAYWRIGHT_CORE_PATH 指向的文件不存在或不可读：${module}`)
  if (!executablePath) problems.push('缺少 PLAYWRIGHT_CHROMIUM_PATH')
  else if (!isAbsolute(executablePath)) problems.push(`PLAYWRIGHT_CHROMIUM_PATH 不是绝对路径：${executablePath}`)
  else if (!readable(executablePath, constants.X_OK)) problems.push(`PLAYWRIGHT_CHROMIUM_PATH 指向的文件不存在或不可执行：${executablePath}`)
  if (problems.length) throw new Error(`浏览器测试环境未配置：${problems.join('；')}。${usage}`)
  return { module, executablePath }
}

export async function loadChromium() {
  const { module, executablePath } = browserLaunchEnv()
  let chromium
  try {
    ;({ chromium } = await import(pathToFileURL(module).href))
  } catch (error) {
    throw new Error(`无法从 PLAYWRIGHT_CORE_PATH 加载 playwright-core（${module}）：${error?.message ?? error}`)
  }
  if (!chromium?.launch) throw new Error(`PLAYWRIGHT_CORE_PATH 加载的模块未导出 chromium.launch：${module}`)
  return { chromium, executablePath }
}
