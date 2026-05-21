import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  server: {
    port: 5510,
    proxy: {
      '/api': 'http://127.0.0.1:7799',
    },
  },
  build: {
    outDir: '../../../docs',
    emptyOutDir: true,
  },
});
