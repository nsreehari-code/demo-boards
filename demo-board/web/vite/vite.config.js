import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5510,
    proxy: {
      '/api': 'http://127.0.0.1:7799',
    },
  },
  build: {
    outDir: '../dist-vite',
  },
});
