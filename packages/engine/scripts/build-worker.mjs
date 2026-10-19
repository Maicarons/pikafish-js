import { build } from 'esbuild';

await build({
  entryPoints: ['src/worker/worker-entry.ts'],
  bundle: true,
  outfile: 'dist/engine.worker.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  legalComments: 'none',
});
