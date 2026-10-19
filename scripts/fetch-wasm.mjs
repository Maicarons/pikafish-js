// Downloads prebuilt WASM release assets and verifies them against SHA256SUMS.
//
// Used by the Vercel demo build (and any deployment that does not want to run
// the full Emscripten toolchain). The GitHub Pages workflow builds from source
// instead, then uses package-wasm.mjs to publish these same assets.
//
// Usage:
//   node scripts/fetch-wasm.mjs [--url <asset-base-url>] [--force]
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outRoot = join(root, 'dist', 'wasm');
const builds = ['threads-simd', 'single-simd', 'single-nosimd'];

const args = parseArgs(process.argv.slice(2));
const base = (args.url ?? process.env.PIKAFISH_WASM_URL ??
  'https://github.com/official-pikafish/pikafish-js/releases/latest/download').replace(/\/+$/, '');

console.log(`Fetching WASM assets from ${base}`);

const sums = await fetchText(`${base}/SHA256SUMS`);
const expected = new Map(
  sums
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts.length === 2)
    .map(([hash, name]) => [name, hash.toLowerCase()]),
);
if (!expected.size) throw new Error('SHA256SUMS is empty or malformed.');
if (expected.size < builds.length * 2) {
  throw new Error(`SHA256SUMS is missing builds; expected ${builds.length * 2} files.`);
}

for (const build of builds) {
  const dir = join(outRoot, build);
  await mkdir(dir, { recursive: true });
  for (const file of ['pikafish.js', 'pikafish.wasm']) {
    const name = `${build}.${file}`;
    const hash = expected.get(name);
    if (!hash) throw new Error(`SHA256SUMS does not list ${name}`);
    const target = join(dir, file);
    if (!args.force && existsSync(target) && (await fileSha256(target)) === hash) {
      console.log(`  ${name} already present and verified`);
      continue;
    }
    const bytes = await fetchBytes(`${base}/${name}`);
    const actual = sha256(bytes);
    if (actual !== hash) throw new Error(`${name} SHA-256 mismatch: expected ${hash}, got ${actual}`);
    await writeFile(target, bytes);
    console.log(`  ${name} verified (${bytes.byteLength} bytes)`);
  }
}

// COPYING and the human-readable manifest are nice to have, not required.
for (const name of ['COPYING.txt', 'wasm-manifest.json']) {
  if (!expected.has(name)) continue;
  const bytes = await fetchBytes(`${base}/${name}`).catch(() => null);
  if (!bytes) continue;
  if (sha256(bytes) !== expected.get(name)) throw new Error(`${name} SHA-256 mismatch`);
  await writeFile(join(outRoot, name === 'wasm-manifest.json' ? 'manifest.json' : name), bytes);
}

console.log(`WASM assets ready in ${outRoot}`);

async function fetchText(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return response.text();
}

async function fetchBytes(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fileSha256(path) {
  return sha256(await readFile(path));
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseArgs(argv) {
  const parsed = { url: null, force: false };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--url') parsed.url = argv[++index];
    else if (value === '--force') parsed.force = true;
  }
  return parsed;
}
