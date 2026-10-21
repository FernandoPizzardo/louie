import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The engine's control API (docs/control-api.md) runs on loopback. In dev we
// proxy /api and /events to it so the browser stays same-origin (the engine
// sends no CORS headers). Set LOUIE_ENGINE to point at a different port.
const engine = process.env.LOUIE_ENGINE ?? 'http://127.0.0.1:8889'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    proxy: {
      '/api': { target: engine, changeOrigin: true },
      '/events': { target: engine, changeOrigin: true, headers: { Connection: 'keep-alive' } },
    },
  },
})
