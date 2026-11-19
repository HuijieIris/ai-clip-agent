import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  base: process.env.GITHUB_PAGES === 'true' ? '/ai-clip-agent/' : '/',
  define: { __GITHUB_PAGES__: JSON.stringify(process.env.GITHUB_PAGES === 'true') },
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5180,
    proxy: {
      // 固定走 IPv4，避免 localhost 在 ::1 / 127.0.0.1 间解析到不同服务
      '/api': 'http://127.0.0.1:8788',
      '/files': 'http://127.0.0.1:8788',
    },
  },
})
