import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Same-origin API in dev (no CORS, no VITE_API_BASE); SSE streams through the proxy.
    proxy: { '/api': { target: process.env.TWINOPS_API_URL ?? 'http://127.0.0.1:8000' } },
  },
  // Preview (used by the E2E suite) must not inherit the dev proxy, so tests stay on the in-browser engine.
  preview: { port: 4173, strictPort: true, proxy: {} },
  build: { sourcemap: false, chunkSizeWarningLimit: 600 },
});
