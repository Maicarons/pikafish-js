// Full static-site build used by Vercel: fetch the pinned prebuilt WASM
// release assets and NNUE weights, assemble the demo, then build both the demo
// and the VitePress docs so the demo footer's `/docs/` link resolves.
import { cp, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const node = process.execPath;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

run(node, ['scripts/fetch-wasm.mjs']);
run(node, ['scripts/fetch-net.mjs']);
run(node, ['scripts/assemble-demo.mjs']);
run(npm, ['run', 'build:rules']);
run(npm, ['run', 'build:engine']);
run(npm, ['run', 'build:demo']);
run(npm, ['run', 'docs:build'], { DOCS_BASE: '/docs/' });

const docsDist = join(root, 'docs', '.vitepress', 'dist');
const target = join(root, 'apps', 'demo', 'dist', 'docs');
await mkdir(target, { recursive: true });
await cp(docsDist, target, { recursive: true });
console.log(`Docs mounted at ${target}`);

function run(command, args, extraEnv = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
}
