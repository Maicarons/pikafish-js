import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(await readFile(join(root, 'engine.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const publicDir = join(root, 'apps', 'demo', 'public', 'engine');
const wasmDir = join(root, 'dist', 'wasm');
const builds = Object.keys(config.builds);
const engines = Object.keys(config.engines);

await mkdir(publicDir, { recursive: true });
// Start from an empty directory: a build that no longer exists (the old
// single-family layout, for instance) must not survive into the deployment.
await rm(publicDir, { recursive: true, force: true });
await mkdir(publicDir, { recursive: true });

const manifest = {
  version: pkg.version,
  upstreamCommit: config.upstream.commit,
  emsdk: config.emsdk,
  engines: {},
};

for (const engine of engines) {
  const spec = config.engines[engine];
  const netSource = join(root, 'assets', spec.net.asset);
  if (!existsSync(netSource)) {
    // The distilled net is published with a release; without it the demo
    // simply offers the strong engine.
    console.log(`Skipping the ${engine} engine: ${spec.net.asset} is not present.`);
    continue;
  }
  const missing = builds.filter(
    (build) => !existsSync(join(wasmDir, engine, build, 'pikafish.js')),
  );
  if (missing.length) {
    // The WebAssembly builds come from Emscripten, which is not always around
    // (a local checkout without emsdk, for instance).
    console.log(`Skipping the ${engine} engine: no build for ${missing.join(', ')}.`);
    continue;
  }

  const entry = { label: spec.label, netLabel: spec.netLabel, builds: {} };
  for (const build of builds) {
    const sourceDir = join(wasmDir, engine, build);
    const targetDir = join(publicDir, engine, build);
    await mkdir(targetDir, { recursive: true });
    await replaceFile(join(sourceDir, 'pikafish.js'), join(targetDir, 'pikafish.js'));
    await replaceFile(join(sourceDir, 'pikafish.wasm'), join(targetDir, 'pikafish.wasm'));
    await replaceFile(join(sourceDir, 'COPYING.txt'), join(targetDir, 'COPYING.txt')).catch(
      () => undefined,
    );
    const js = await stat(join(targetDir, 'pikafish.js'));
    const wasm = await stat(join(targetDir, 'pikafish.wasm'));
    entry.builds[build] = {
      js: `engine/${engine}/${build}/pikafish.js`,
      wasm: `engine/${engine}/${build}/pikafish.wasm`,
      bytes: js.size + wasm.size,
    };
  }

  const netTarget = join(publicDir, spec.net.asset);
  await replaceFile(netSource, netTarget);
  const net = await stat(netTarget);
  const netHash = await fileSha256(netTarget);
  entry.net = { url: `engine/${spec.net.asset}`, size: net.size, sha256: netHash };
  manifest.engines[engine] = entry;
  console.log(`NNUE (${engine}): ${net.size} bytes ${netHash}`);
}

if (!Object.keys(manifest.engines).length) {
  throw new Error('No engine assets were assembled.');
}

await atomicWrite(join(publicDir, 'engine.json'), (path) =>
  writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`),
);
console.log(`Demo engine assets assembled in ${publicDir}`);

// Replace a file by writing a sibling and renaming over the target, so a reader
// never observes a half-written wasm/NNUE. A running `npm run dev` (or a browser
// downloading these very files) can still hold the target open on Windows, which
// makes the rename fail; retry briefly, then fail with advice instead of a
// confusing EBUSY stack trace.
async function replaceFile(source, target) {
  await atomicWrite(target, (path) => copyFile(source, path));
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
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
}

async function fileSha256(path) {
  const buffer = await readFile(path);
  return createHash('sha256').update(buffer).digest('hex');
}
