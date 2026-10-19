import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outRoot = process.argv[2] ?? join(root, 'dist', 'wasm');
const builds = ['threads-simd', 'single-simd', 'single-nosimd'];
const manifest = { generatedAt: new Date().toISOString(), builds: {} };

for (const build of builds) {
  const jsPath = join(outRoot, build, 'pikafish.js');
  const wasmPath = join(outRoot, build, 'pikafish.wasm');
  const [js, wasm] = await Promise.all([readFile(jsPath), readFile(wasmPath)]);
  manifest.builds[build] = {
    js: { bytes: (await stat(jsPath)).size, sha256: sha256(js) },
    wasm: { bytes: (await stat(wasmPath)).size, sha256: sha256(wasm) },
  };
}

await writeFile(join(outRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
