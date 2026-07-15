import path from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/config': 'http://127.0.0.1:5011',
      '/health': 'http://127.0.0.1:5011',
      '/metrics': 'http://127.0.0.1:5011',
      '/ready': 'http://127.0.0.1:5011',
      '/ws': {
        target: 'ws://127.0.0.1:5011',
        ws: true,
      },
    },
  },
})
