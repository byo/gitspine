import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Production assets are written into internal/ui/dist for go:embed.
// Dev still uses Vite on :5173 with /api proxied to the Go server.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: '../internal/ui/dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
})
