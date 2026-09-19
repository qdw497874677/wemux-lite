import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// playground/ -> tailgrids-fidelity/ -> scripts/ -> web/ -> apps/ -> 仓库根
const repoRoot = resolve(here, '../../../../..')
const webSrc = resolve(repoRoot, 'apps/web/src')
const repoModules = resolve(repoRoot, 'node_modules')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // 我们的组件按 web 应用里的真实别名解析，避免工装里出现第二套源码
      '@': webSrc,
      // 上游 registry 源码：由 prepare.mjs 从 WEMUX_TAILGRIDS_SRC 拷进来，不入库
      '@up': resolve(here, 'src/up-core'),
      // 两侧共用仓库根的那一份 React，避免一个页面里出现两个 React 实例
      react: `${repoModules}/react`,
      'react-dom': `${repoModules}/react-dom`,
      'react/jsx-runtime': `${repoModules}/react/jsx-runtime.js`,
    },
  },
  server: { port: 5199, host: '127.0.0.1', strictPort: true },
})