import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(await readFile(join(root, 'engine.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const publicDir = join(root, 'apps', 'demo', 'public', 'engine');
const wasmDir = join(root, 'dist', 'wasm');
const netSource = join(root, 'assets', 'pikafish.nnue');
const netTarget = join(publicDir, 'pikafish.nnue');

await mkdir(publicDir, { recursive: true });

const builds = {};
for (const build of ['threads-simd', 'single-simd', 'single-nosimd']) {
  const sourceDir = join(wasmDir, build);
  const targetDir = join(publicDir, build);
  await mkdir(targetDir, { recursive: true });
  await copyFile(join(sourceDir, 'pikafish.js'), join(targetDir, 'pikafish.js'));
  await copyFile(join(sourceDir, 'pikafish.wasm'), join(targetDir, 'pikafish.wasm'));
  await copyFile(join(sourceDir, 'COPYING.txt'), join(targetDir, 'COPYING.txt')).catch(() => undefined);
  const js = await stat(join(targetDir, 'pikafish.js'));
  const wasm = await stat(join(targetDir, 'pikafish.wasm'));
  builds[build] = {
    js: `engine/${build}/pikafish.js`,
    wasm: `engine/${build}/pikafish.wasm`,
    bytes: js.size + wasm.size,
  };
}

await copyFile(netSource, netTarget);
const net = await stat(netTarget);
const netHash = await fileSha256(netTarget);

const manifest = {
  version: pkg.version,
  upstreamCommit: config.upstream.commit,
  emsdk: config.emsdk,
  net: {
    url: 'engine/pikafish.nnue',
    size: net.size,
    sha256: netHash,
  },
  builds,
};
await writeFile(join(publicDir, 'engine.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Demo engine assets assembled in ${publicDir}`);
console.log(`NNUE: ${net.size} bytes ${netHash}`);

async function fileSha256(path) {
  const buffer = await readFile(path);
  return createHash('sha256').update(buffer).digest('hex');
}
