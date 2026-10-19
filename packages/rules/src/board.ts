import {
  BLACK,
  RED,
  START_FEN,
  type Board,
  type Color,
  type Piece,
  type PieceType,
  type Position,
  type Square,
  inBounds,
} from './types.js';

export class RulesError extends Error {
  constructor(message: string, readonly code = 'RULES_ERROR') {
    super(message);
    this.name = 'RulesError';
  }
}

const FEN_PIECES: Record<string, PieceType> = {
  k: 'k',
  a: 'a',
  b: 'b',
  n: 'n',
  r: 'r',
  c: 'c',
  p: 'p',
};

export function emptyBoard(): Board {
  return Array.from({ length: 10 }, () => Array.from({ length: 9 }, () => null));
}

export function cloneBoard(board: Board): Board {
  return board.map(row => row.map(piece => (piece ? { ...piece } : null)));
}

export function pieceAt(board: Board, square: Square): Piece | null {
  if (!inBounds(square)) return null;
  return board[square.rank]?.[square.file] ?? null;
}

export function setPiece(board: Board, square: Square, piece: Piece | null): void {
  if (!inBounds(square)) throw new RulesError(`Square out of bounds: ${square.file},${square.rank}`);
  const row = board[square.rank];
  if (!row) throw new RulesError(`Board row missing: ${square.rank}`);
  row[square.file] = piece;
}

export function findKing(board: Board, color: Color): Square | null {
  for (let rank = 0; rank < 10; rank++) {
    for (let file = 0; file < 9; file++) {
      const piece = board[rank]?.[file];
      if (piece?.color === color && piece.type === 'k') return { file, rank };
    }
  }
  return null;
}

export function parseFen(fen: string): Position {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) throw new RulesError('FEN must contain at least 4 fields', 'FEN_INVALID');
  const [placement, side, , , halfmoveText, fullmoveText] = parts;
  if (!placement) throw new RulesError('FEN placement missing', 'FEN_INVALID');

  const rows = placement.split('/');
  if (rows.length !== 10) throw new RulesError('Xiangqi FEN must have 10 ranks', 'FEN_INVALID');

  const board = emptyBoard();
  for (let displayRank = 0; displayRank < 10; displayRank++) {
    const row = rows[displayRank]!;
    const rank = 9 - displayRank;
    let file = 0;
    for (const char of row) {
      if (/[1-9]/.test(char)) {
        file += Number(char);
        continue;
      }
      const type = FEN_PIECES[char.toLowerCase()];
      if (!type) throw new RulesError(`Invalid FEN piece: ${char}`, 'FEN_INVALID');
      if (file > 8) throw new RulesError('FEN rank has more than 9 files', 'FEN_INVALID');
      setPiece(board, { file, rank }, { color: char === char.toUpperCase() ? RED : BLACK, type });
      file++;
    }
    if (file !== 9) throw new RulesError(`FEN rank ${displayRank + 1} does not contain 9 files`, 'FEN_INVALID');
  }

  const turn: Color = side === 'b' || side === 'B' ? BLACK : RED;
  if (side !== 'w' && side !== 'W' && side !== 'b' && side !== 'B' && side !== 'r' && side !== 'R') {
    throw new RulesError(`Invalid FEN side to move: ${side}`, 'FEN_INVALID');
  }

  const redKing = findKing(board, RED);
  const blackKing = findKing(board, BLACK);
  if (!redKing || !blackKing) throw new RulesError('FEN must contain exactly one king per side', 'FEN_INVALID');

  const halfmove = halfmoveText ? Number(halfmoveText) : 0;
  const fullmove = fullmoveText ? Number(fullmoveText) : 1;
  if (!Number.isInteger(halfmove) || halfmove < 0) {
    throw new RulesError('FEN halfmove clock must be a non-negative integer', 'FEN_INVALID');
  }
  if (!Number.isInteger(fullmove) || fullmove < 1) {
    throw new RulesError('FEN fullmove number must be a positive integer', 'FEN_INVALID');
  }

  return { board, turn, halfmove, fullmove };
}

export function toFen(position: Position): string {
  const rows: string[] = [];
  for (let displayRank = 0; displayRank < 10; displayRank++) {
    const rank = 9 - displayRank;
    let row = '';
    let empty = 0;
    for (let file = 0; file < 9; file++) {
      const piece = position.board[rank]?.[file] ?? null;
      if (!piece) {
        empty++;
        continue;
      }
      if (empty > 0) {
        row += String(empty);
        empty = 0;
      }
      const letter = piece.type;
      row += piece.color === 'w' ? letter.toUpperCase() : letter;
    }
    if (empty > 0) row += String(empty);
    rows.push(row);
  }
  return `${rows.join('/')} ${position.turn} - - ${position.halfmove} ${position.fullmove}`;
}

export function startPosition(): Position {
  return parseFen(START_FEN);
}

export function boardKey(position: Position): string {
  const rows: string[] = [];
  for (let rank = 0; rank < 10; rank++) {
    let row = '';
    for (let file = 0; file < 9; file++) {
      const piece = position.board[rank]?.[file];
      row += piece ? (piece.color === 'w' ? piece.type.toUpperCase() : piece.type) : '.';
    }
    rows.push(row);
  }
  return `${rows.join('/')} ${position.turn}`;
}

export function positionKey(position: Position): string {
  return `${boardKey(position)} ${position.halfmove} ${position.fullmove}`;
}

export function countPieces(board: Board): Record<Color, Record<PieceType, number>> {
  const counts: Record<Color, Record<PieceType, number>> = {
    w: { k: 0, a: 0, b: 0, n: 0, r: 0, c: 0, p: 0 },
    b: { k: 0, a: 0, b: 0, n: 0, r: 0, c: 0, p: 0 },
  };
  for (const row of board) {
    for (const piece of row) {
      if (piece) counts[piece.color][piece.type]++;
    }
  }
  return counts;
}
