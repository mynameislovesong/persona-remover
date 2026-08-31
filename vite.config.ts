import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/persona-remover/',
  plugins: [react()],
  build: {
    target: 'es2020',
  },
})
