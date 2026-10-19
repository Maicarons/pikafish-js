import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const resolvePath = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

// The demo loads nothing from a third party: the engine glue, its pthread
// workers and the 48 MB NNUE weights are all same-origin, and the board squares
// position themselves with inline `style` attributes. `'wasm-unsafe-eval'` is
// required for WebAssembly compilation (Chrome 97+, Safari 16.4+).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

// Injected into production HTML only: `vite dev` serves inline scripts and a
// websocket for HMR, which this policy forbids. `vercel.json` sends the same
// policy as a header on the deployed site.
function contentSecurityPolicy(): Plugin {
  return {
    name: 'pikafish-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => ({
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
            injectTo: 'head-prepend',
          },
        ],
      }),
    },
  };
}

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [contentSecurityPolicy()],
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
      {
        find: /^@pikafish-js\/rules$/,
        replacement: resolvePath('../../packages/rules/src/index.ts'),
      },
      {
        find: /^pikafish-js\/worker-runtime$/,
        replacement: resolvePath('../../packages/engine/src/worker-runtime.ts'),
      },
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
