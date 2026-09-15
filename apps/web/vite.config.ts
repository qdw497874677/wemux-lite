import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The web console talks to the API server through these same-origin passthrough
// prefixes, so the console origin can also serve as the Worker Server URL.
const serverOrigin = process.env.WEMUX_SERVER_ORIGIN ?? 'http://127.0.0.1:3001'
const passthrough = { target: serverOrigin, changeOrigin: true }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 8002,
    proxy: {
      '^/api(?:/|$)': {
        target: serverOrigin,
        changeOrigin: true,
        rewrite: requestPath => requestPath.replace(/^\/api/, ''),
        configure(proxy) {
          // EventSource cannot set Bearer headers; forward the query credential as a Bearer header.
          // NOTE: Bun 1.3+ makes ClientRequest.path readonly, so we must NOT
          // rewrite proxyRequest.path here — the backend accepts ?token= itself,
          // so leaving it in the query is equivalent and Bun-safe.
          proxy.on('proxyReq', (proxyRequest, request) => {
            const url = new URL(request.url ?? '/', 'http://localhost')
            const token = url.searchParams.get('token')
            if (token && /^\/sessions\/[^/]+\/stream$/.test(url.pathname)) {
              proxyRequest.setHeader('Authorization', `Bearer ${token}`)
            }
          })
        },
      },
      // Worker data plane: installer + tarball downloads, enrollment and the
      // WebSocket gateway, and agent capability callbacks.
      '^/downloads(?:/|$)': passthrough,
      '^/workers(?:/|$)': { ...passthrough, ws: true },
      '^/agent-capabilities(?:/|$)': passthrough,
    },
  },
})
