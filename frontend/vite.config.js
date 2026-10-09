import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss()
  ],
  server: {
    proxy: {
      '/ketcher-api': {
        target: 'https://lifescience.opensource.epam.com/ketcher/api/v1',
        changeOrigin: true
      }
    }
  },
  define: {
    'process.env': {},
    'process': { env: {} },
    'global': 'window'
  }
})
