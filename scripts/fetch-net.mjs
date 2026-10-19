import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'engine.json'), 'utf8'));
const target = join(root, 'assets', 'pikafish.nnue');

await mkdir(dirname(target), { recursive: true });

if (existsSync(target)) {
  const current = await stat(target);
  const hash = await fileSha256(target);
  if (current.size === config.net.size && hash === config.net.sha256) {
    console.log(`NNUE already present: ${target} (${current.size} bytes)`);
    process.exit(0);
  }
  console.log('Existing NNUE does not match engine.json; downloading again.');
}

console.log(`Downloading ${config.net.url}`);
const response = await fetch(config.net.url, { redirect: 'follow' });
if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

const total = Number(response.headers.get('content-length') ?? 0);
let loaded = 0;
const source = Readable.fromWeb(response.body);
source.on('data', chunk => {
  loaded += chunk.length;
  if (total) {
    const percent = ((loaded / total) * 100).toFixed(1);
    process.stdout.write(`\r${percent}% ${loaded}/${total} bytes`);
  }
});
await pipeline(source, (await import('node:fs')).createWriteStream(target));
process.stdout.write('\n');

const info = await stat(target);
const hash = await fileSha256(target);
if (info.size !== config.net.size || hash !== config.net.sha256) {
  throw new Error(`NNUE verification failed: size=${info.size} sha256=${hash}`);
}
console.log(`NNUE verified: ${info.size} bytes ${hash}`);

async function fileSha256(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}
