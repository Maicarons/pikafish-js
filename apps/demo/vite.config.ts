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
    rollupOptions: {
      input: {
        // The benchmark page is a real deliverable: it is the only place the
        // pthread wasm modules can be measured, so the documented numbers can be
        // reproduced on any device without a Node toolchain.
        index: resolvePath('index.html'),
        bench: resolvePath('bench.html'),
      },
      output: {
        // Without this, Rollup names the chunk shared by both pages after one of
        // its modules (`engine.worker-*.js`), which reads like the packaged worker.
        chunkFileNames: 'assets/chunk-[hash].js',
      },
    },
  },
});
