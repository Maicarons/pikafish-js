#!/usr/bin/env node
// Dependency-free static file server for local verification, the e2e suite and
// the benchmark workflow.
//
// The demo needs a server that can be switched between "sends COOP/COEP" (how
// Vercel and `vite preview` behave) and "sends nothing" (a plain static host,
// where `coi-serviceworker` has to restore isolation). Both cases are part of
// the test matrix, so the choice is a flag rather than a different tool.
//
//   node scripts/serve-static.mjs --root apps/demo/dist --port 4173
//   node scripts/serve-static.mjs --root apps/demo/dist --port 4176 --isolation=off
//
// As a library: `const server = await listen({ root, isolation: false })` gives
// back the chosen port (useful with `port: 0`) and a `close()`.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.nnue': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function createStaticServer({ root, isolation = true, cache = 'no-store' }) {
  const rootDir = resolve(root);

  return createServer(async (request, response) => {
    const headers = {
      'Cache-Control': cache === 'no-store' ? 'no-store' : 'public, max-age=60',
      'Content-Type': 'text/plain; charset=utf-8',
    };
    if (isolation) {
      headers['Cross-Origin-Opener-Policy'] = 'same-origin';
      headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
      headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400, headers).end('Bad request');
      return;
    }

    let target = resolve(join(rootDir, pathname));
    // Refuse anything that escapes the root, including `..` after decoding.
    if (target !== rootDir && !target.startsWith(rootDir + sep)) {
      response.writeHead(403, headers).end('Forbidden');
      return;
    }

    try {
      let info = await stat(target);
      if (info.isDirectory()) {
        target = join(target, 'index.html');
        info = await stat(target);
      }
      headers['Content-Type'] = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
      headers['Content-Length'] = String(info.size);
      response.writeHead(200, headers);
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      createReadStream(target)
        // A client that goes away mid-download (or a cancelled request) must not
        // take the server down with it.
        .on('error', () => response.destroy())
        .pipe(response);
    } catch {
      response.writeHead(404, headers).end('Not found');
    }
  });
}

export async function listen({ root, port = 0, isolation = true, cache = 'no-store', host = '127.0.0.1' }) {
  const server = createStaticServer({ root, isolation, cache });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolvePromise);
  });
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : port,
    close: () => new Promise(resolvePromise => server.close(() => resolvePromise())),
  };
}

function parseArgs(argv) {
  const args = { root: 'apps/demo/dist', port: 4173, isolation: true, silent: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    // Accept both `--key=value` and `--key value`.
    const [key, inlineValue] = arg.replace(/^--/, '').split('=');
    const takesValue = key === 'root' || key === 'port' || key === 'isolation';
    const value = inlineValue ?? (takesValue ? (argv[++index] ?? '') : '');
    if (key === 'root') args.root = value;
    else if (key === 'port') args.port = Number(value);
    else if (key === 'isolation') args.isolation = value !== 'off' && value !== 'false';
    else if (key === 'silent') args.silent = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const server = await listen(args);
  if (!args.silent) {
    console.log(
      `Serving ${resolve(args.root)} on http://127.0.0.1:${server.port} ` +
        `(isolation ${args.isolation ? 'on' : 'off'})`,
    );
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void server.close().then(() => process.exit(0));
    });
  }
}
