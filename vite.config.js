import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'renderer-dist',
    emptyOutDir: true,
    // Split the vendor libraries out of the app bundle. Everything loads from
    // local disk in Electron, so this is about clean chunking (and silencing
    // the >500 kB warning), not network performance.
    rollupOptions: {
      output: {
        // Rolldown (Vite 8) only supports the function form.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('@tabler')) return 'icons'
          if (/node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'react'
          return 'vendor'
        },
      },
    },
    chunkSizeWarningLimit: 1200,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
