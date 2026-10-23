#!/usr/bin/env node
// Publishes the npm packages from the current checkout. The release workflow
// runs this at the tagged commit; the manual workflow can run it against an
// older tag, where the two packages intentionally have different versions.
//
//   node scripts/publish-npm.mjs [dist-tag] [--stage] [--dry-run]
//
// With --stage the version goes to npm's staging queue instead of the public
// registry; a maintainer approves it with 2FA later. Staging needs no OTP, so
// it works with a granular token that cannot bypass 2FA.
//
// Each package is checked under its own name and version. Using the engine
// version for both made a v0.2.0 run try to publish rules 0.1.0 again, because
// the rules package was not bumped in that release.

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const dryRun = process.argv.includes('--dry-run');
const stage = process.argv.includes('--stage');
const distTag = process.argv.slice(2).find((arg) => !arg.startsWith('-')) ?? 'latest';

if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(distTag)) {
  console.error(`invalid npm dist-tag: ${distTag}`);
  process.exit(1);
}

// A staged version is not on the registry yet, so `npm view` cannot see it.
// Checking the stage queue keeps a re-run from trying to stage it twice.
const alreadyStaged = stage && !dryRun ? stagedVersions() : new Set();

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

  if (alreadyStaged.has(spec)) {
    console.log(`${spec} is already staged; leaving it alone.`);
    continue;
  }

  const action = stage ? 'stage' : 'publish';
  const verb = dryRun ? `would ${action}` : action === 'stage' ? 'staging' : 'publishing';
  console.log(`${verb} ${spec} with dist-tag "${distTag}"`);
  const args = [
    ...(stage ? ['stage'] : []),
    'publish',
    '--access',
    'public',
    '--tag',
    distTag,
    '--workspace',
    workspace,
  ];
  if (!dryRun) args.push('--provenance');
  if (dryRun) args.push('--dry-run');

  if (!stage) {
    runNpm(args);
    continue;
  }

  const stdout = runNpm([...args, '--json'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const result = JSON.parse(stdout.toString());
  const stageId = result?.[manifest.name]?.stageId;
  if (!dryRun && stageId) console.log(`staged ${spec} with stage id ${stageId}`);
}

function stagedVersions() {
  // `npm stage` requires npm >= 11.15.0; the publish workflows install it.
  const stdout = runNpm(['stage', 'list', '--json'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const items = JSON.parse(stdout.toString() || '[]');
  return new Set(items.map((item) => `${item.packageName}@${item.version}`));
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
  return execFileSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  });
}
