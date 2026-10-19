#!/usr/bin/env node
// Runs bench.html in a real browser and writes the machine-readable report.
//
//   node scripts/bench.mjs
//   node scripts/bench.mjs --movetime 1000 --out bench-results/local.json
//   node scripts/bench.mjs --baseline bench-results/previous.json --threshold 0.2
//
// Prerequisites: `npm run site` (the built demo with engine assets) and the
// Playwright browsers (`npx playwright install chromium`).
//
// Numbers are only comparable on the same machine and browser build, which is
// why the comparison is against an earlier run rather than a shared table.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';
import { listen } from './serve-static.mjs';

const BROWSERS = { chromium, firefox, webkit };

const args = parseArgs(process.argv.slice(2));

const server = await listen({ root: args.root, port: 0, isolation: true });
const browserType = BROWSERS[args.browser];
if (!browserType) throw new Error(`Unknown browser: ${args.browser}`);

const browser = await browserType.launch();
const browserVersion = browser.version();
let report;
try {
  const page = await browser.newPage();
  const url = `http://127.0.0.1:${server.port}/bench.html?movetime=${args.movetime}`;
  console.log(`Benchmarking ${url} (${args.browser})`);
  await page.goto(url);
  await page.waitForFunction(() => Boolean(globalThis.__bench?.done), undefined, {
    timeout: args.timeout,
  });
  report = await page.evaluate(() => globalThis.__bench);
} finally {
  await browser.close();
  await server.close();
}

if (!report) throw new Error('the bench page produced no report');
if (report.error) throw new Error(`the bench page failed: ${report.error}`);

const payload = {
  ...report,
  capturedAt: new Date().toISOString(),
  browser: args.browser,
  browserVersion,
};

await mkdir(dirname(resolve(args.out)), { recursive: true });
await writeFile(resolve(args.out), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`\nWrote ${args.out}`);
console.log(`\n${toMarkdown(payload)}`);

let regressions = [];
if (!args.baseline) {
  console.log('\nNo baseline given; nothing to compare.');
} else {
  const baseline = JSON.parse(await readFile(resolve(args.baseline), 'utf8'));

  // Search time changes the numbers by an order of magnitude, and so does the
  // browser, so a comparison across either is meaningless. The scheduled job
  // downloads whatever the previous run produced, which may be a manual run.
  if (baseline.movetime !== payload.movetime || baseline.browser !== payload.browser) {
    console.log(
      `\nSkipping comparison: the baseline is ${baseline.browser ?? 'unknown'} at ` +
        `${baseline.movetime ?? '?'} ms, this run is ${payload.browser} at ${payload.movetime} ms.`,
    );
  } else {
    const comparison = compare(payload, baseline, args.threshold);
    regressions = comparison.regressions;

    console.log(`\nAgainst ${args.baseline} (threshold ${(args.threshold * 100).toFixed(0)}%):`);
    for (const row of comparison.rows) {
      const arrow = row.change >= 0 ? 'up' : 'down';
      console.log(
        `  ${row.key.padEnd(20)} ${formatNps(row.before)} -> ${formatNps(row.after)} NPS (${(row.change * 100).toFixed(1)}% ${arrow})`,
      );
    }
    for (const row of regressions) {
      annotate(
        'warning',
        `${row.key}: ${formatNps(row.before)} -> ${formatNps(row.after)} NPS (${(row.change * 100).toFixed(1)}%)`,
      );
    }
    if (!comparison.rows.length) console.log('  no matching builds in the baseline');
  }
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const summary = [
    '### Pikafish benchmark',
    '',
    toMarkdown(payload),
    '',
    `Browser: ${args.browser} ${browserVersion}; movetime ${args.movetime} ms.`,
    regressions.length
      ? `\n**${regressions.length} build(s) more than ${(args.threshold * 100).toFixed(0)}% slower than the baseline.**`
      : '',
    '',
  ].join('\n');
  await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
}

if (regressions.length && args.failOnRegression) process.exit(1);

function compare(current, baseline, threshold) {
  // `threads-simd` is measured twice (4 threads and 1 thread), so the build name
  // alone is not a unique key.
  const key = (row) => `${row.build}@${row.appliedThreads ?? row.requestedThreads}`;
  const rows = [];
  const regressions = [];
  for (const row of current.rows ?? []) {
    const before = (baseline.rows ?? []).find((candidate) => key(candidate) === key(row));
    if (!before?.nps || !row.nps) continue;
    const change = (row.nps - before.nps) / before.nps;
    rows.push({ key: key(row), before: before.nps, after: row.nps, change });
    if (change < -threshold) {
      regressions.push({ key: key(row), before: before.nps, after: row.nps, change });
    }
  }
  return { rows, regressions };
}

function toMarkdown(report) {
  const header = '| Build | Threads | Hash | Init | Depth | Nodes | NPS | Best move |';
  const divider = '| --- | --- | --- | --- | --- | --- | --- | --- |';
  const rows = (report.rows ?? []).map((row) =>
    row.ok
      ? `| \`${row.build}\` | ${row.appliedThreads} | ${row.hashMB} MB | ${row.initMs} ms | ${row.depth} | ${row.nodes} | ${row.nps} | ${row.bestmove} |`
      : `| \`${row.build}\` | ${row.requestedThreads} | — | ${row.initMs} ms | — | — | — | ${row.error} |`,
  );
  return [header, divider, ...rows, '', `> ${report.environment.split('\n').join(' · ')}`].join(
    '\n',
  );
}

function formatNps(value) {
  return `${Math.round(value).toLocaleString('en-US')}`;
}

function annotate(level, message) {
  console.log(`::${level}::${message.replace(/\r?\n/g, ' ')}`);
}

function parseArgs(argv) {
  const options = {
    root: 'apps/demo/dist',
    movetime: 3000,
    out: 'bench-results/bench.json',
    baseline: null,
    threshold: 0.2,
    browser: 'chromium',
    timeout: 600_000,
    failOnRegression: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [key, inline] = argv[index].replace(/^--/, '').split('=');
    const value = inline ?? argv[index + 1];
    switch (key) {
      case 'root':
        options.root = value;
        if (inline === undefined) index += 1;
        break;
      case 'movetime':
        options.movetime = Number(value);
        if (inline === undefined) index += 1;
        break;
      case 'out':
        options.out = value;
        if (inline === undefined) index += 1;
        break;
      case 'baseline':
        options.baseline = value;
        if (inline === undefined) index += 1;
        break;
      case 'threshold':
        options.threshold = Number(value);
        if (inline === undefined) index += 1;
        break;
      case 'browser':
        options.browser = value;
        if (inline === undefined) index += 1;
        break;
      case 'timeout':
        options.timeout = Number(value);
        if (inline === undefined) index += 1;
        break;
      case 'fail-on-regression':
        options.failOnRegression = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return options;
}
