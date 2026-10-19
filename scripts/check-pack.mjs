#!/usr/bin/env node
// Validates what would actually be published (release checklist §6.1).
//
//   node scripts/check-pack.mjs
//
// Rules that matter for this project:
//   - the core package must not contain NNUE weights (50 MB, and they carry
//     their own distribution terms)
//   - the AGPL text and the NOTICE must be in the tarball
//   - the prebuilt worker entry point must be there, hosts import it directly
//   - the tarball stays small enough to publish without care

import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(exec);
const root = fileURLToPath(new URL('..', import.meta.url));

const MAX_TARBALL_BYTES = 2 * 1024 * 1024;

const expectations = [
  {
    workspace: 'pikafish-js',
    directory: 'packages/engine',
    required: [
      'LICENSE',
      'NOTICE',
      'README.md',
      'CHANGELOG.md',
      'dist/index.js',
      'dist/index.d.ts',
      'dist/engine.worker.js',
    ],
  },
  {
    workspace: '@pikafish-js/rules',
    directory: 'packages/rules',
    required: [
      'LICENSE',
      'NOTICE',
      'README.md',
      'CHANGELOG.md',
      'dist/index.js',
      'dist/index.d.ts',
    ],
  },
];

const failures = [];

for (const expectation of expectations) {
  const tarball = await pack(expectation.workspace);
  const paths = (tarball.files ?? []).map((file) => file.path);

  console.log(
    `\n${expectation.workspace} -> ${tarball.filename} (${kb(tarball.size)}, ${paths.length} files)`,
  );

  // npm provenance refuses to sign a package without a repository field, and a
  // private access flag only fails at the last moment during publish.
  const manifest = JSON.parse(
    await readFile(join(root, expectation.directory, 'package.json'), 'utf8'),
  );
  if (!String(manifest.repository?.url ?? '').includes('github.com')) {
    failures.push(`${expectation.workspace}: package.json needs a GitHub repository url`);
  }
  if (manifest.publishConfig?.access !== 'public') {
    failures.push(`${expectation.workspace}: publishConfig.access must be "public"`);
  }

  for (const required of expectation.required) {
    if (!paths.includes(required)) failures.push(`${expectation.workspace}: missing ${required}`);
  }

  const weights = paths.filter((path) => path.endsWith('.nnue'));
  if (weights.length) {
    failures.push(`${expectation.workspace}: contains NNUE weights (${weights.join(', ')})`);
  }

  if (tarball.size > MAX_TARBALL_BYTES) {
    failures.push(
      `${expectation.workspace}: tarball is ${kb(tarball.size)}, over the ${kb(MAX_TARBALL_BYTES)} limit`,
    );
  }

  for (const path of paths) console.log(`  ${path}`);
}

if (failures.length) {
  console.error('\npackage check failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('\npackage check passed.');

async function pack(workspace) {
  // `npm` is npm.cmd on Windows, which needs a shell; a single command string
  // keeps Node from warning about unescaped arguments. Workspace names here are
  // constants, never user input.
  const { stdout } = await run(`npm pack --dry-run --json --workspace "${workspace}"`, {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  const [tarball] = JSON.parse(stdout);
  if (!tarball) throw new Error(`npm pack produced no result for ${workspace}`);
  return tarball;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}
