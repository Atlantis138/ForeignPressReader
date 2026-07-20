import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const tauriDevHost = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'tauri-mobile-dev-entry',
      configureServer(server) {
        if (!tauriDevHost) return
        server.middlewares.use((request, _response, next) => {
          if (request.url === '/' || request.url === '/index.html') request.url = '/tauri.html'
          next()
        })
      },
    },
  ],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        electron: 'index.html',
        tauri: 'tauri.html',
      },
    },
  },
  server: {
    host: tauriDevHost ?? '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: tauriDevHost ? { host: tauriDevHost, port: 5173 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
})
