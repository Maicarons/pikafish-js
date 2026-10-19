#!/usr/bin/env node
// `npm pack` only ships files that live inside the package directory, so the
// AGPL text and the upstream NOTICE have to be copied in first. Keeping two
// copies in git would be pointless, so this runs from `prepack` and the copies
// are ignored by git.
//
//   node scripts/copy-license.mjs packages/engine

import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = resolve(process.cwd(), process.argv[2] ?? '.');

for (const name of ['LICENSE', 'NOTICE']) {
  await copyFile(resolve(root, name), resolve(target, name));
}

// Silent on purpose: `prepack` output would otherwise be mixed into the JSON
// that `npm pack --json` prints.
