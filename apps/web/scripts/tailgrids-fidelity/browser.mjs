// 保真工装的浏览器驱动加载：playwright-core 刻意不作为仓库依赖（会顺带下载浏览器），
// 约定与 apps/web/scripts/verify-component-library.mjs 一致：
//   WEMUX_PLAYWRIGHT  指向 playwright-core 的入口（默认沙箱里那份）
//   WEMUX_CHROME      指向 chromium 可执行文件（不设则用 playwright 自己的解析）
const playwrightEntry = process.env.WEMUX_PLAYWRIGHT ?? '/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs'
const chrome = process.env.WEMUX_CHROME ?? '/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'

let chromium
for (const candidate of ['playwright-core', playwrightEntry]) {
  try {
    ;({ chromium } = await import(candidate))
    break
  } catch (cause) {
    if (candidate === playwrightEntry) {
      throw new Error(`加载 playwright-core 失败。用 WEMUX_PLAYWRIGHT 指到它的入口文件再试。原始错误: ${cause}`)
    }
  }
}

export { chromium }
export const launchOptions = (extra = {}) => ({
  executablePath: process.env.WEMUX_CHROME ?? chrome,
  ...extra,
})