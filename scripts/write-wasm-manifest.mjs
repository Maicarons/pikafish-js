import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outRoot = process.argv[2] ?? join(root, 'dist', 'wasm');
const config = JSON.parse(await readFile(join(root, 'engine.json'), 'utf8'));
const builds = Object.keys(config.builds);
const engines = Object.keys(config.engines);
const manifest = { generatedAt: new Date().toISOString(), engines: {} };

for (const engine of engines) {
  manifest.engines[engine] = { l1: config.engines[engine].l1, builds: {} };
  for (const build of builds) {
    const jsPath = join(outRoot, engine, build, 'pikafish.js');
    const wasmPath = join(outRoot, engine, build, 'pikafish.wasm');
    const [js, wasm] = await Promise.all([readFile(jsPath), readFile(wasmPath)]);
    manifest.engines[engine].builds[build] = {
      js: { bytes: (await stat(jsPath)).size, sha256: sha256(js) },
      wasm: { bytes: (await stat(wasmPath)).size, sha256: sha256(wasm) },
    };
  }
}

await writeFile(join(outRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
