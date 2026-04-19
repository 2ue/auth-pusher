import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'

const currentDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(currentDir, './src'),
      '@shared': path.resolve(currentDir, '../shared'),
    },
  },
  server: {
    port: 5573,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3771',
        changeOrigin: true,
      },
    },
  },
})
