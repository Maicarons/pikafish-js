export type Color = 'w' | 'b';
export type PieceType = 'k' | 'a' | 'b' | 'n' | 'r' | 'c' | 'p';

export interface Piece {
  color: Color;
  type: PieceType;
}

/** Board is indexed [rank][file]. rank 0 is Red's home rank, rank 9 is Black's home rank. */
export type Board = Array<Array<Piece | null>>;

export interface Square {
  file: number;
  rank: number;
}

export interface Move {
  from: Square;
  to: Square;
}

export interface Position {
  board: Board;
  turn: Color;
  halfmove: number;
  fullmove: number;
}

export interface FenInfo extends Position {}

export type GameResult = 'red' | 'black' | 'draw' | null;

export type GameReason =
  | 'checkmate'
  | 'stalemate'
  | 'repetition'
  | 'perpetual-check'
  | 'sixty-move'
  | 'insufficient'
  | 'resign'
  | 'timeout'
  | null;

export interface GameStatus {
  over: boolean;
  result: GameResult;
  reason: GameReason;
  inCheck: boolean;
  legalMoves: number;
}

export interface MoveRecord {
  move: Move;
  ucci: string;
  piece: Piece;
  captured: Piece | null;
  fenBefore: string;
  fenAfter: string;
  check: boolean;
  notation: string;
}

export const FILES = 'abcdefghi';
export const RED: Color = 'w';
export const BLACK: Color = 'b';
export const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

export const PIECE_NAMES: Record<PieceType, { red: string; black: string }> = {
  k: { red: '帅', black: '将' },
  a: { red: '仕', black: '士' },
  b: { red: '相', black: '象' },
  n: { red: '马', black: '马' },
  r: { red: '车', black: '车' },
  c: { red: '炮', black: '炮' },
  p: { red: '兵', black: '卒' },
};

export function opposite(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

export function inBounds(square: Square): boolean {
  return (
    Number.isInteger(square.file) &&
    Number.isInteger(square.rank) &&
    square.file >= 0 &&
    square.file <= 8 &&
    square.rank >= 0 &&
    square.rank <= 9
  );
}

export function sameSquare(a: Square, b: Square): boolean {
  return a.file === b.file && a.rank === b.rank;
}

export function squareName(square: Square): string {
  return `${FILES[square.file] ?? '?'}${square.rank}`;
}

export function parseSquare(value: string): Square | null {
  if (!/^[a-i][0-9]$/.test(value)) return null;
  const file = FILES.indexOf(value[0]!);
  const rank = Number(value[1]);
  return file >= 0 && rank >= 0 && rank <= 9 ? { file, rank } : null;
}

export function moveToUcci(move: Move): string {
  return `${squareName(move.from)}${squareName(move.to)}`;
}

export function parseUcci(value: string): Move | null {
  const text = value.trim().toLowerCase();
  if (text.length !== 4) return null;
  const from = parseSquare(text.slice(0, 2));
  const to = parseSquare(text.slice(2, 4));
  return from && to ? { from, to } : null;
}

export function isRedPiece(piece: Piece | null | undefined): boolean {
  return !!piece && piece.color === 'w';
}

export function pieceToFen(piece: Piece): string {
  const letter = piece.type;
  return piece.color === 'w' ? letter.toUpperCase() : letter;
}
