#!/usr/bin/env node
// Publishes the npm packages from the current checkout. The release workflow
// runs this at the tagged commit; the manual workflow can run it against an
// older tag, where the two packages intentionally have different versions.
//
//   node scripts/publish-npm.mjs [dist-tag] [--dry-run]
//
// Each package is checked under its own name and version. Using the engine
// version for both made a v0.2.0 run try to publish rules 0.1.0 again, because
// the rules package was not bumped in that release.

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const dryRun = process.argv.includes('--dry-run');
const distTag = process.argv.slice(2).find((arg) => !arg.startsWith('-')) ?? 'latest';

if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(distTag)) {
  console.error(`invalid npm dist-tag: ${distTag}`);
  process.exit(1);
}

const packages = [
  { workspace: '@pikafish-js/rules', directory: 'packages/rules' },
  { workspace: 'pikafish-js', directory: 'packages/engine' },
];

for (const { workspace, directory } of packages) {
  const manifest = JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8'));
  const spec = `${manifest.name}@${manifest.version}`;

  if (isPublished(manifest.name, manifest.version)) {
    console.log(`${spec} is already on npm; leaving it alone.`);
    continue;
  }

  console.log(`${dryRun ? 'would publish' : 'publishing'} ${spec} with dist-tag "${distTag}"`);
  const args = ['publish', '--access', 'public', '--tag', distTag, '--workspace', workspace];
  if (!dryRun) args.push('--provenance');
  if (dryRun) args.push('--dry-run');
  runNpm(args);
}

function isPublished(name, version) {
  try {
    runNpm(['view', `${name}@${version}`, 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runNpm(args, options = {}) {
  // cmd.exe resolves npm.cmd without execFileSync's shell option, which would
  // concatenate arguments instead of escaping them.
  const windows = process.platform === 'win32';
  const command = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const commandArgs = windows ? ['/d', '/s', '/c', 'npm', ...args] : args;
  execFileSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  });
}
