import { defineConfig } from 'vite'

export default defineConfig({
  root: 'frontend',
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  }
})