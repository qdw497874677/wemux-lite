import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Delivery uses the existing Server at /next/, never a second preview backend.
// API and host discovery URLs stay origin-relative (/api/*), not under this base.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/next/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: 'dist', assetsDir: 'assets' },
})
