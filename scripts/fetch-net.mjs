import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(
  await (await import('node:fs/promises')).readFile(join(root, 'engine.json'), 'utf8'),
);

await mkdir(join(root, 'assets'), { recursive: true });

for (const [engine, spec] of Object.entries(config.engines)) {
  await fetchNet(engine, spec.net);
}

async function fetchNet(engine, net) {
  const target = join(root, 'assets', net.asset);

  if (existsSync(target)) {
    const current = await stat(target);
    const hash = await fileSha256(target);
    if (current.size === net.size && hash === net.sha256) {
      console.log(`NNUE (${engine}) already present: ${target} (${current.size} bytes)`);
      return;
    }
    console.log(`Existing NNUE (${engine}) does not match engine.json; downloading again.`);
  }

  console.log(`Downloading NNUE (${engine}) from ${net.url}`);
  let response;
  try {
    response = await fetch(net.url, { redirect: 'follow' });
  } catch (error) {
    // The distilled net is published with the release, so it is simply not
    // there yet on a fresh checkout of a tag that predates it.  That is not a
    // build failure: the demo then ships the strong engine only.
    if (engine !== 'strong') {
      console.warn(`NNUE (${engine}) is not available yet: ${error.message}`);
      console.warn(`Continuing without the ${engine} engine.`);
      return;
    }
    throw error;
  }
  if (!response.ok || !response.body) {
    if (engine !== 'strong') {
      console.warn(`NNUE (${engine}) is not available yet: HTTP ${response.status}`);
      console.warn(`Continuing without the ${engine} engine.`);
      return;
    }
    throw new Error(`HTTP ${response.status}`);
  }

  const total = Number(response.headers.get('content-length') ?? 0);
  let loaded = 0;
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
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
  if (info.size !== net.size || hash !== net.sha256) {
    if (engine !== 'strong') {
      console.warn(`NNUE (${engine}) failed verification; continuing without it.`);
      await rm(target);
      return;
    }
    throw new Error(`NNUE verification failed: size=${info.size} sha256=${hash}`);
  }
  console.log(`NNUE (${engine}) verified: ${info.size} bytes ${hash}`);
}

async function rm(path) {
  await (await import('node:fs/promises')).rm(path, { force: true });
}

async function fileSha256(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}
