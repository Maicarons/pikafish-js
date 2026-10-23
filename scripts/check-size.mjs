#!/usr/bin/env node
// Size guard for the packaged WASM builds (roadmap §4.2).
//
// A dropped optimisation flag, a debug build or an accidental source map shows
// up here as a jump long before anyone notices it in the browser.
//
//   node scripts/check-size.mjs
//   node scripts/check-size.mjs --dir dist/release
//
// Exits non-zero when a file or the total goes over budget.

import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const BUDGETS = [
  { match: (name) => name.endsWith('.wasm'), label: 'WebAssembly', maxBytes: 900 * 1024 },
  { match: (name) => name.endsWith('.js'), label: 'JS glue', maxBytes: 150 * 1024 },
];

// Nine variants now (three engine widths, three capability builds each),
// about 0.7 MB per wasm+js pair.
const TOTAL_MAX_BYTES = 8 * 1024 * 1024;

const args = process.argv.slice(2);
const dirIndex = args.indexOf('--dir');
const dir = resolve(dirIndex >= 0 ? (args[dirIndex + 1] ?? 'dist/release') : 'dist/release');

const entries = (await readdir(dir, { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();

const files = [];
for (const name of entries) {
  const budget = BUDGETS.find((candidate) => candidate.match(name));
  if (!budget) continue;
  const { size } = await stat(join(dir, name));
  files.push({ name, label: budget.label, size, maxBytes: budget.maxBytes });
}

if (!files.length) {
  console.error(`No packaged artefacts found in ${dir}. Run \`npm run package:wasm\` first.`);
  process.exit(1);
}

const total = files.reduce((sum, file) => sum + file.size, 0);
const failures = [
  ...files.filter((file) => file.size > file.maxBytes),
  ...(total > TOTAL_MAX_BYTES
    ? [{ name: 'total', label: 'all artefacts', size: total, maxBytes: TOTAL_MAX_BYTES }]
    : []),
];

console.log(`Size check for ${dir}`);
console.log('');
for (const file of [
  ...files,
  { name: 'total', label: 'all artefacts', size: total, maxBytes: TOTAL_MAX_BYTES },
]) {
  const kb = (file.size / 1024).toFixed(1).padStart(8);
  const budget = (file.maxBytes / 1024).toFixed(0).padStart(6);
  const over = file.size > file.maxBytes;
  console.log(
    `  ${over ? 'OVER' : ' ok '}  ${file.name.padEnd(34)} ${kb} KB  (limit ${budget} KB)`,
  );
}

if (failures.length) {
  console.error(`\n${failures.length} artefact(s) over budget.`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `\n**WASM size check failed** for ${failures.map((file) => file.name).join(', ')}.\n`,
    );
  }
  process.exit(1);
}

console.log(`\nAll ${files.length} artefacts within budget.`);
