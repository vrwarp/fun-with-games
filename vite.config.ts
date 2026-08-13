import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

/**
 * When deployed to GitHub Pages the app is served from
 * `https://<user>.github.io/<repo>/`, so assets need a non-root base path.
 * The Pages workflow sets `BASE_PATH=/<repo>/`; local dev stays at `/`.
 */
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Babylon is large; the warning is expected and not actionable for a starter.
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks: {
          babylon: ['@babylonjs/core', '@babylonjs/loaders'],
          net: ['trystero'],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
