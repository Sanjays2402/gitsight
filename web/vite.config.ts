import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// GitSight web frontend (W2).
//
// The standalone SPA REUSES the extension's stack-agnostic renderer:
// `@shared/*` resolves to ../src/shared/* so the lane layout, palette,
// and snapshot contract are imported, never forked. Vite + esbuild
// transpile the shared .ts on the fly during dev and bundle them at
// build time.
export default defineConfig({
  root: '.',
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../src/shared', import.meta.url)),
    },
  },
  server: {
    port: 5273,
    // During dev, proxy the snapshot API to the bundled companion server
    // so `vite dev` and `node server/index.mjs` can run side by side.
    proxy: {
      '/api': 'http://127.0.0.1:5274',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
