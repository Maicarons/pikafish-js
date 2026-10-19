import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const resolvePath = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  server: {
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
  worker: {
    format: 'iife',
  },
  resolve: {
    alias: [
      { find: /^@pikafish-js\/rules$/, replacement: resolvePath('../../packages/rules/src/index.ts') },
      { find: /^pikafish-js\/worker-runtime$/, replacement: resolvePath('../../packages/engine/src/worker-runtime.ts') },
      { find: /^pikafish-js$/, replacement: resolvePath('../../packages/engine/src/index.ts') },
    ],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
