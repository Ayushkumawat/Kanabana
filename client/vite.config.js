import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => ({
  plugins: [react()],
  base: process.env.VITE_BASE || '/',
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': process.env.VITE_API || 'http://127.0.0.1:4050',
    },
  },
}));
