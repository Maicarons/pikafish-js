#!/usr/bin/env node
// Checks that documentation links resolve and that every page is reachable from
// the sidebar. VitePress catches broken links only for pages it knows about, and
// only at build time in strict mode, so this runs in `verify` instead.
//
//   node scripts/check-links.mjs
//
// Checks:
//   - relative links (`./api.md`, `../plan/roadmap.md`) point at an existing page
//   - site-absolute links (`/guide/api`) point at an existing page
//   - every markdown page under docs/ appears in the VitePress sidebar

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const docsDir = join(root, 'docs');
const configPath = join(docsDir, '.vitepress', 'config.mts');

const pages = await collect(docsDir);
const config = await readFile(configPath, 'utf8');

const broken = [];
const orphans = [];
let checked = 0;

for (const page of [...pages, join(root, 'README.md')]) {
  const text = stripCode(await readFile(page, 'utf8'));

  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim();
    if (/^(https?:|mailto:|tel:|data:|#)/i.test(raw)) continue;

    const target = raw.split(/\s+/)[0]; // drop an optional "title"
    const withoutHash = target.split('#')[0].split('?')[0];
    if (!withoutHash) continue;

    checked += 1;
    if (!(await exists(page, withoutHash))) {
      broken.push(`${rel(page)} -> ${target}`);
    }
  }
}

for (const page of pages) {
  const route = routeOf(page);
  if (route === '/' || route === '/index') continue;
  if (!config.includes(`'${route}'`)) orphans.push(`${rel(page)} (${route})`);
}

if (broken.length) {
  console.error(`\nbroken links (${broken.length}):`);
  for (const entry of broken) console.error(`  - ${entry}`);
}
if (orphans.length) {
  console.error(`\npages missing from the sidebar (${orphans.length}):`);
  for (const entry of orphans) console.error(`  - ${entry}`);
}

if (broken.length || orphans.length) process.exit(1);

console.log(`link check passed: ${checked} links across ${pages.length} pages, no orphans.`);

async function collect(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.vitepress' || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await collect(path)));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}

/** VitePress route for a page: docs/guide/api.md -> /guide/api */
function routeOf(page) {
  const path = relative(docsDir, page).split(sep).join('/').replace(/\.md$/, '');
  return `/${path.replace(/(^|\/)index$/, '')}`.replace(/\/$/, '') || '/';
}

async function exists(fromPage, target) {
  const candidates = target.startsWith('/')
    ? [
        join(docsDir, ...target.split('/').filter(Boolean)),
        join(docsDir, ...target.split('/').filter(Boolean)) + '.md',
        join(docsDir, ...target.split('/').filter(Boolean), 'index.md'),
      ]
    : [
        resolve(dirname(fromPage), target),
        resolve(dirname(fromPage), target) + '.md',
        resolve(dirname(fromPage), target, 'index.md'),
      ];

  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return true;
    } catch {
      // try the next shape
    }
  }
  return false;
}

/** Removes fenced blocks so example links are not checked. */
function stripCode(text) {
  return text.replace(/^ {0,3}(```|~~~)[\s\S]*?^ {0,3}\1.*$/gm, '');
}

function rel(page) {
  return relative(root, page).split(sep).join('/');
}
