import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => {
  const local = loadEnv(mode, process.cwd(), 'API_PROXY_');
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: process.env.API_PROXY_TARGET ?? local.API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
    preview: { port: 4173 },
    build: { target: 'es2022' },
  };
});
