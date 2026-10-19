// Packages the three WASM builds as individual release assets plus a
// SHA256SUMS file, so CI/Vercel can fetch and verify them without a tar
// extraction step.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = process.argv[2] ?? join(root, 'dist', 'wasm');
const outDir = process.argv[3] ?? join(root, 'dist', 'release');
const builds = ['threads-simd', 'single-simd', 'single-nosimd'];

await mkdir(outDir, { recursive: true });

const sums = [];
for (const build of builds) {
  for (const [suffix, file] of [
    ['pikafish.js', 'pikafish.js'],
    ['pikafish.wasm', 'pikafish.wasm'],
  ]) {
    const source = join(sourceRoot, build, file);
    const name = `${build}.${suffix}`;
    const target = join(outDir, name);
    await copyFile(source, target);
    sums.push(`${await fileSha256(target)}  ${name}`);
  }
}

const copying = join(sourceRoot, 'threads-simd', 'COPYING.txt');
await copyFile(copying, join(outDir, 'COPYING.txt')).catch(() => undefined);
try {
  await copyFile(join(sourceRoot, 'manifest.json'), join(outDir, 'wasm-manifest.json'));
} catch {
  // The manifest is optional; SHA256SUMS is authoritative.
}

await writeFile(join(outDir, 'SHA256SUMS'), `${sums.sort().join('\n')}\n`);
console.log(`Release assets written to ${outDir}`);

async function fileSha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
