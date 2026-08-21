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
        // Rollup 5 (via Vite 8) dropped the object form of manualChunks, so
        // this is the function equivalent: same two chunks, matched by module
        // id instead of by entry package.
        manualChunks(id: string): string | undefined {
          if (id.includes('node_modules/@babylonjs/')) return 'babylon';
          if (id.includes('node_modules/trystero')) return 'net';
          return undefined;
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
