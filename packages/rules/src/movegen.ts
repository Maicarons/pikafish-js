import {
  opposite,
  type Board,
  type Color,
  type Move,
  type Piece,
  type Position,
  type Square,
  inBounds,
  moveToUcci,
} from './types.js';
import { findKing, pieceAt, cloneBoard, setPiece } from './board.js';

const ORTHOGONAL: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const DIAGONAL: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const KNIGHT: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 2, 0, 1],
  [-1, 2, 0, 1],
  [1, -2, 0, -1],
  [-1, -2, 0, -1],
  [2, 1, 1, 0],
  [2, -1, 1, 0],
  [-2, 1, -1, 0],
  [-2, -1, -1, 0],
];

function addMove(
  board: Board,
  moves: Move[],
  from: Square,
  piece: Piece,
  file: number,
  rank: number,
): void {
  const to = { file, rank };
  if (!inBounds(to)) return;
  const target = pieceAt(board, to);
  if (target && target.color === piece.color) return;
  moves.push({ from, to });
}

function inPalace(square: Square, color: Color): boolean {
  const fileOk = square.file >= 3 && square.file <= 5;
  const rankOk =
    color === 'w' ? square.rank >= 0 && square.rank <= 2 : square.rank >= 7 && square.rank <= 9;
  return fileOk && rankOk;
}

function crossedRiver(square: Square, color: Color): boolean {
  return color === 'w' ? square.rank >= 5 : square.rank <= 4;
}

/** Moves a single piece could make, ignoring whether they leave the king in check. */
export function pseudoMovesFrom(board: Board, from: Square): Move[] {
  const piece = pieceAt(board, from);
  if (!piece) return [];
  const moves: Move[] = [];
  const forward = piece.color === 'w' ? 1 : -1;

  switch (piece.type) {
    case 'k': {
      for (const [df, dr] of ORTHOGONAL) {
        const to = { file: from.file + df, rank: from.rank + dr };
        if (inPalace(to, piece.color)) addMove(board, moves, from, piece, to.file, to.rank);
      }
      // Flying general: the king may capture the opposing king on an open file.
      for (const dr of [1, -1]) {
        for (let rank = from.rank + dr; rank >= 0 && rank <= 9; rank += dr) {
          const target = pieceAt(board, { file: from.file, rank });
          if (!target) continue;
          if (target.type === 'k' && target.color !== piece.color) {
            moves.push({ from, to: { file: from.file, rank } });
          }
          break;
        }
      }
      break;
    }
    case 'a': {
      for (const [df, dr] of DIAGONAL) {
        const to = { file: from.file + df, rank: from.rank + dr };
        if (inPalace(to, piece.color)) addMove(board, moves, from, piece, to.file, to.rank);
      }
      break;
    }
    case 'b': {
      for (const [df, dr] of DIAGONAL) {
        const to = { file: from.file + df * 2, rank: from.rank + dr * 2 };
        if (!inBounds(to)) continue;
        if (piece.color === 'w' ? to.rank > 4 : to.rank < 5) continue;
        const eye = { file: from.file + df, rank: from.rank + dr };
        if (pieceAt(board, eye)) continue;
        addMove(board, moves, from, piece, to.file, to.rank);
      }
      break;
    }
    case 'n': {
      for (const [df, dr, lf, lr] of KNIGHT) {
        const leg = { file: from.file + lf, rank: from.rank + lr };
        if (pieceAt(board, leg)) continue;
        addMove(board, moves, from, piece, from.file + df, from.rank + dr);
      }
      break;
    }
    case 'r': {
      for (const [df, dr] of ORTHOGONAL) {
        for (let step = 1; step < 10; step++) {
          const to = { file: from.file + df * step, rank: from.rank + dr * step };
          if (!inBounds(to)) break;
          const target = pieceAt(board, to);
          if (!target) {
            moves.push({ from, to });
            continue;
          }
          if (target.color !== piece.color) moves.push({ from, to });
          break;
        }
      }
      break;
    }
    case 'c': {
      for (const [df, dr] of ORTHOGONAL) {
        let screen = false;
        for (let step = 1; step < 10; step++) {
          const to = { file: from.file + df * step, rank: from.rank + dr * step };
          if (!inBounds(to)) break;
          const target = pieceAt(board, to);
          if (!screen) {
            if (!target) {
              moves.push({ from, to });
            } else {
              screen = true;
            }
            continue;
          }
          if (target) {
            if (target.color !== piece.color) moves.push({ from, to });
            break;
          }
        }
      }
      break;
    }
    case 'p': {
      addMove(board, moves, from, piece, from.file, from.rank + forward);
      if (crossedRiver(from, piece.color)) {
        addMove(board, moves, from, piece, from.file + 1, from.rank);
        addMove(board, moves, from, piece, from.file - 1, from.rank);
      }
      break;
    }
  }

  return moves;
}

/** Every pseudo-legal move for the side to move, before the check filter. */
export function generatePseudoMoves(position: Position): Move[] {
  const moves: Move[] = [];
  for (let rank = 0; rank < 10; rank++) {
    for (let file = 0; file < 9; file++) {
      const piece = position.board[rank]?.[file];
      if (piece?.color === position.turn)
        moves.push(...pseudoMovesFrom(position.board, { file, rank }));
    }
  }
  return moves;
}

/** True when the two kings share a file with nothing between them (illegal position). */
export function kingsFacing(board: Board): boolean {
  const red = findKing(board, 'w');
  const black = findKing(board, 'b');
  if (!red || !black || red.file !== black.file) return false;
  const from = Math.min(red.rank, black.rank) + 1;
  const to = Math.max(red.rank, black.rank);
  for (let rank = from; rank < to; rank++) {
    if (pieceAt(board, { file: red.file, rank })) return false;
  }
  return true;
}

/** Whether any piece of `byColor` attacks the target square. */
export function isAttacked(board: Board, target: Square, byColor: Color): boolean {
  for (let rank = 0; rank < 10; rank++) {
    for (let file = 0; file < 9; file++) {
      const piece = board[rank]?.[file];
      if (!piece || piece.color !== byColor) continue;
      const attacks = pseudoMovesFrom(board, { file, rank });
      if (attacks.some((move) => move.to.file === target.file && move.to.rank === target.rank))
        return true;
    }
  }
  return false;
}

/** Whether `color` is in check. A missing king counts as check, so broken FEN fails loudly. */
export function isKingInCheck(position: Position, color: Color): boolean {
  const king = findKing(position.board, color);
  if (!king) return true;
  if (kingsFacing(position.board)) return true;
  return isAttacked(position.board, king, opposite(color));
}

/**
 * Plays a move and returns the resulting position. The input is not mutated.
 *
 * Does not check legality: pair it with {@link isLegalMove} or use `Game`.
 *
 * @example
 * ```ts
 * const next = applyMove(parseFen(START_FEN), { from: { file: 7, rank: 2 }, to: { file: 4, rank: 2 } });
 * next.turn; // 'b'
 * ```
 */
export function applyMove(position: Position, move: Move): Position {
  const piece = pieceAt(position.board, move.from);
  if (!piece) throw new Error(`No piece at ${move.from.file},${move.from.rank}`);
  const target = pieceAt(position.board, move.to);
  if (target?.color === piece.color) throw new Error('Cannot capture own piece');

  const board = cloneBoard(position.board);
  setPiece(board, move.from, null);
  setPiece(board, move.to, { ...piece });

  return {
    board,
    turn: opposite(position.turn),
    halfmove: piece.type === 'p' || target ? 0 : position.halfmove + 1,
    fullmove: position.turn === 'b' ? position.fullmove + 1 : position.fullmove,
  };
}

/** Shape-and-piece check only: no king-safety filter. */
export function isPseudoLegalMove(position: Position, move: Move): boolean {
  const piece = pieceAt(position.board, move.from);
  if (!piece || piece.color !== position.turn) return false;
  return pseudoMovesFrom(position.board, move.from).some(
    (candidate) => candidate.to.file === move.to.file && candidate.to.rank === move.to.rank,
  );
}

/**
 * Full legality: piece movement plus "does not leave own king in check",
 * including the flying-general rule.
 *
 * @example
 * ```ts
 * const position = parseFen(START_FEN);
 * isLegalMove(position, { from: { file: 1, rank: 2 }, to: { file: 4, rank: 2 } }); // true
 * ```
 */
export function isLegalMove(position: Position, move: Move): boolean {
  if (!isPseudoLegalMove(position, move)) return false;
  const next = applyMove(position, move);
  return !isKingInCheck(next, position.turn);
}

/**
 * All legal moves for the side to move (44 in the initial position).
 *
 * @example
 * ```ts
 * generateLegalMoves(parseFen(START_FEN)).length; // 44
 * ```
 */
export function generateLegalMoves(position: Position): Move[] {
  return generatePseudoMoves(position).filter((move) => {
    const next = applyMove(position, move);
    return !isKingInCheck(next, position.turn);
  });
}

/** Legal moves for one piece, the shape a board UI needs when a square is selected. */
export function legalMovesFrom(position: Position, from: Square): Move[] {
  return generateLegalMoves(position).filter(
    (move) => move.from.file === from.file && move.from.rank === from.rank,
  );
}

/** Renders a move as UCCI, e.g. `h2e2`. Alias of `moveToUcci` for symmetry with `moveFromText`. */
export function moveText(move: Move): string {
  return moveToUcci(move);
}

/**
 * Parses UCCI text into a move, returning `null` when it is malformed **or**
 * illegal in this position — the two cases a board UI cannot distinguish.
 *
 * @example
 * ```ts
 * moveFromText(parseFen(START_FEN), 'h2e2'); // { from: { file: 7, rank: 2 }, to: { file: 4, rank: 2 } }
 * ```
 */
export function moveFromText(position: Position, text: string): Move | null {
  const normalized = text.trim().toLowerCase();
  const match = /^([a-i][0-9])([a-i][0-9])$/.exec(normalized);
  if (!match) return null;
  const from = parseSquareText(match[1]!);
  const to = parseSquareText(match[2]!);
  if (!from || !to) return null;
  const move = { from, to };
  return isLegalMove(position, move) ? move : null;
}

function parseSquareText(value: string): Square | null {
  const file = 'abcdefghi'.indexOf(value[0]!);
  const rank = Number(value[1]);
  return file >= 0 && rank >= 0 && rank <= 9 ? { file, rank } : null;
}
