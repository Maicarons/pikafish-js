import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
  await replaceFile(join(sourceDir, 'pikafish.js'), join(targetDir, 'pikafish.js'));
  await replaceFile(join(sourceDir, 'pikafish.wasm'), join(targetDir, 'pikafish.wasm'));
  await replaceFile(join(sourceDir, 'COPYING.txt'), join(targetDir, 'COPYING.txt')).catch(() => undefined);
  const js = await stat(join(targetDir, 'pikafish.js'));
  const wasm = await stat(join(targetDir, 'pikafish.wasm'));
  builds[build] = {
    js: `engine/${build}/pikafish.js`,
    wasm: `engine/${build}/pikafish.wasm`,
    bytes: js.size + wasm.size,
  };
}

await replaceFile(netSource, netTarget);
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
await atomicWrite(join(publicDir, 'engine.json'), path => writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`));
console.log(`Demo engine assets assembled in ${publicDir}`);
console.log(`NNUE: ${net.size} bytes ${netHash}`);

// Replace a file by writing a sibling and renaming over the target, so a reader
// never observes a half-written wasm/NNUE. A running `npm run dev` (or a browser
// downloading these very files) can still hold the target open on Windows, which
// makes the rename fail; retry briefly, then fail with advice instead of a
// confusing EBUSY stack trace.
async function replaceFile(source, target) {
  await atomicWrite(target, path => copyFile(source, path));
}

async function atomicWrite(target, write) {
  const temp = `${target}.tmp`;
  await rm(temp, { force: true });
  await write(temp);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      if (attempt >= 10) {
        await rm(temp, { force: true });
        throw new Error(
          `Could not replace ${target} (${error.code}). ` +
            'Stop the demo dev server or close the browser tab using it, then retry.',
          { cause: error },
        );
      }
      await new Promise(resolve => setTimeout(resolve, attempt * 100));
    }
  }
}

async function fileSha256(path) {
  const buffer = await readFile(path);
  return createHash('sha256').update(buffer).digest('hex');
}
