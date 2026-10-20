/*
  Generates diverse, independently-legal FENs for the training pipeline.

  The points it has to hit: all 32 layer-stack buckets (they are picked from
  piece counts, so random games do cover them, but only if enough games are
  played to the end), both sides to move, and a wide spread of material.

  Usage: node training/tools/gen-fens.mjs <out.txt> [games] [seed]
*/

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  applyMove,
  generateLegalMoves,
  parseFen,
  pieceAt,
  setPiece,
  startPosition,
  toFen,
} from '../../packages/rules/dist/index.js';

const out = process.argv[2];
const games = Number(process.argv[3] ?? 200);
const seed = Number(process.argv[4] ?? 20260101);
if (!out) {
  console.error('usage: node training/tools/gen-fens.mjs <out.txt> [games] [seed]');
  process.exit(2);
}

// deterministic PRNG so a parity failure can be reproduced exactly
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(seed);
const fens = new Set();

/*
  The 32 layer stacks are selected from (rooks, rooks, knights+cannons,
  knights+cannons), so a position that keeps all four rooks can only ever reach
  a handful of them.  Thinning the material is what covers the rest.
*/
function sparseStart() {
  const pos = parseFen('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1');
  for (let y = 0; y < 10; ++y) {
    for (let x = 0; x < 9; ++x) {
      const piece = pieceAt(pos.board, { x, y });
      if (!piece || piece.type === 'k') continue;
      if (rand() < 0.6) setPiece(pos.board, { x, y }, null);
    }
  }
  return pos;
}

let plies = 0;

for (let g = 0; g < games; ++g) {
  // two thirds of the games start from thinned material
  let pos = rand() < 0.66 ? sparseStart() : startPosition();
  if (g % 2 === 1) {
    // both sides get sampled: the bucket is computed from the mover's view
    const moves = generateLegalMoves(pos);
    if (moves.length) pos = applyMove(pos, moves[Math.floor(rand() * moves.length)]);
  }

  // random games mostly end in a capture race; cap them so no game eats all
  // the time, and sample as we go
  const maxPlies = 30 + Math.floor(rand() * 90);
  for (let p = 0; p < maxPlies; ++p) {
    if (p % 2 === 0) {
      fens.add(toFen(pos));
      ++plies;
    }
    const moves = generateLegalMoves(pos);
    if (moves.length === 0) break;
    pos = applyMove(pos, moves[Math.floor(rand() * moves.length)]);
  }
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, [...fens].join('\n') + '\n');
console.error(`wrote ${fens.size} positions from ${games} games (${plies} samples)`);
