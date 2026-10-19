import { pieceAt } from './board.js';
import {
  FILES,
  PIECE_NAMES,
  type Color,
  type Move,
  type Piece,
  type Position,
  type Square,
} from './types.js';

const NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

function numeral(value: number): string {
  return NUMERALS[value - 1] ?? String(value);
}

function fileNumber(color: Color, file: number): number {
  return color === 'w' ? 9 - file : file + 1;
}

function pieceName(piece: Piece): string {
  return piece.color === 'w' ? PIECE_NAMES[piece.type].red : PIECE_NAMES[piece.type].black;
}

function sameFilePieces(position: Position, from: Square, piece: Piece): Square[] {
  const squares: Square[] = [];
  for (let rank = 0; rank < 10; rank++) {
    const candidate = pieceAt(position.board, { file: from.file, rank });
    if (candidate?.color === piece.color && candidate.type === piece.type) {
      squares.push({ file: from.file, rank });
    }
  }
  return squares.sort((a, b) => (piece.color === 'w' ? b.rank - a.rank : a.rank - b.rank));
}

function originLabel(position: Position, from: Square, piece: Piece): string {
  const sameFile = sameFilePieces(position, from, piece);
  if (sameFile.length <= 1) return `${pieceName(piece)}${numeral(fileNumber(piece.color, from.file))}`;

  const index = sameFile.findIndex(square => square.rank === from.rank && square.file === from.file);
  if (sameFile.length === 2) return `${index === 0 ? '前' : '后'}${pieceName(piece)}`;
  if (sameFile.length === 3) {
    return `${index === 0 ? '前' : index === 1 ? '中' : '后'}${pieceName(piece)}`;
  }
  return `${index === 0 ? '前' : index === sameFile.length - 1 ? '后' : numeral(index + 1)}${pieceName(piece)}`;
}

/**
 * Chinese move notation from the moving side's perspective.
 * Examples: 炮二平五, 马八进七, 卒7进1 (black uses its own file numbering).
 */
export function toChineseNotation(position: Position, move: Move): string {
  const piece = pieceAt(position.board, move.from);
  if (!piece) return '';

  const origin = originLabel(position, move.from, piece);
  const destFile = fileNumber(piece.color, move.to.file);
  const fromFile = FILES[move.from.file] ?? '?';

  if (move.to.rank === move.from.rank) {
    return `${origin}平${numeral(destFile)}`;
  }

  const forward = piece.color === 'w' ? move.to.rank > move.from.rank : move.to.rank < move.from.rank;
  const action = forward ? '进' : '退';

  // Advisors, bishops and knights describe the destination file, not distance.
  if (piece.type === 'a' || piece.type === 'b' || piece.type === 'n') {
    return `${origin}${action}${numeral(destFile)}`;
  }

  const distance = Math.abs(move.to.rank - move.from.rank);
  // A rook/cannon/pawn/king moving from one file to another always says 平 above;
  // this branch therefore covers straight-line movement.
  return `${origin}${action}${numeral(distance || fileNumber(piece.color, move.from.file))}`;
}

export function moveWithCheckSuffix(notation: string, check: boolean, mate: boolean): string {
  if (mate) return `${notation}#`;
  if (check) return `${notation}+`;
  return notation;
}
