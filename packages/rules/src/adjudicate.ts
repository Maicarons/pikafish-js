import {
  boardKey,
  cloneBoard,
  countPieces,
  findKing,
  parseFen,
  toFen,
} from './board.js';
import {
  applyMove,
  generateLegalMoves,
  isKingInCheck,
  isLegalMove,
  kingsFacing,
  legalMovesFrom,
  moveFromText,
} from './movegen.js';
import { toChineseNotation, moveWithCheckSuffix } from './notation.js';
import {
  START_FEN,
  opposite,
  moveToUcci,
  type Color,
  type GameReason,
  type GameResult,
  type GameStatus,
  type Move,
  type MoveRecord,
  type Position,
} from './types.js';

export function insufficientMaterial(position: Position): boolean {
  const counts = countPieces(position.board);
  for (const color of ['w', 'b'] as const) {
    const c = counts[color];
    if (c.r > 0 || c.n > 0 || c.c > 0 || c.p > 0) return false;
  }
  return true;
}

export function evaluatePosition(position: Position): GameStatus {
  const legalMoves = generateLegalMoves(position);
  const inCheck = isKingInCheck(position, position.turn);

  if (legalMoves.length === 0) {
    return {
      over: true,
      result: inCheck ? (position.turn === 'w' ? 'black' : 'red') : position.turn === 'w' ? 'black' : 'red',
      reason: inCheck ? 'checkmate' : 'stalemate',
      inCheck,
      legalMoves: 0,
    };
  }

  if (insufficientMaterial(position)) {
    return { over: true, result: 'draw', reason: 'insufficient', inCheck, legalMoves: legalMoves.length };
  }

  if (position.halfmove >= 120) {
    return { over: true, result: 'draw', reason: 'sixty-move', inCheck, legalMoves: legalMoves.length };
  }

  return { over: false, result: null, reason: null, inCheck, legalMoves: legalMoves.length };
}

export class Game {
  private current: Position;
  private records: MoveRecord[] = [];
  private keys: string[] = [];
  private resigned: Color | null = null;
  private version = 0;
  private statusCache: GameStatus | null = null;
  private statusVersion = -1;

  constructor(fen: string = START_FEN) {
    this.current = parseFen(fen);
    this.keys = [this.key(this.current)];
  }

  static fromFen(fen: string): Game {
    return new Game(fen);
  }

  get position(): Position {
    return this.current;
  }

  get fen(): string {
    return toFen(this.current);
  }

  get turn(): Color {
    return this.current.turn;
  }

  get board() {
    return cloneBoard(this.current.board);
  }

  get history(): readonly MoveRecord[] {
    return this.records;
  }

  get lastMove(): MoveRecord | null {
    return this.records.at(-1) ?? null;
  }

  legalMoves(): Move[] {
    return generateLegalMoves(this.current);
  }

  legalMovesFrom(square: { file: number; rank: number }): Move[] {
    return legalMovesFrom(this.current, square);
  }

  isLegal(move: Move): boolean {
    return isLegalMove(this.current, move);
  }

  isCheck(color: Color = this.current.turn): boolean {
    return isKingInCheck(this.current, color);
  }

  checkmate(): boolean {
    const status = this.status();
    return status.over && status.reason === 'checkmate';
  }

  status(): GameStatus {
    if (this.statusCache && this.statusVersion === this.version) return this.statusCache;
    const status = this.computeStatus();
    this.statusCache = status;
    this.statusVersion = this.version;
    return status;
  }

  private computeStatus(): GameStatus {
    if (this.resigned) {
      return {
        over: true,
        result: this.resigned === 'w' ? 'black' : 'red',
        reason: 'resign',
        inCheck: isKingInCheck(this.current, this.current.turn),
        legalMoves: 0,
      };
    }

    const base = evaluatePosition(this.current);
    const repetitions = this.repetitionCount();
    if (!base.over && repetitions >= 3) {
      const perpetual = this.perpetualCheckSide();
      if (perpetual === 'w' || perpetual === 'b') {
        return {
          ...base,
          over: true,
          result: perpetual === 'w' ? 'black' : 'red',
          reason: 'perpetual-check',
        };
      }
      return { ...base, over: true, result: 'draw', reason: 'repetition' };
    }
    return base;
  }

  repetitionCount(): number {
    const key = this.key(this.current);
    return this.keys.filter(candidate => candidate === key).length;
  }

  move(move: Move): MoveRecord {
    const status = this.status();
    if (status.over) throw new Error(`Game is over: ${status.reason ?? 'unknown'}`);
    if (!this.isLegal(move)) throw new Error(`Illegal move: ${moveToUcci(move)}`);

    const before = this.current;
    const piece = before.board[move.from.rank]?.[move.from.file];
    if (!piece) throw new Error(`No piece at ${move.from.file},${move.from.rank}`);
    const captured = before.board[move.to.rank]?.[move.to.file] ?? null;
    const after = applyMove(before, move);
    const check = isKingInCheck(after, after.turn);
    const reason = evaluatePosition(after);
    const notation = moveWithCheckSuffix(
      toChineseNotation(before, move),
      check,
      reason.over && reason.reason === 'checkmate',
    );

    const record: MoveRecord = {
      move,
      ucci: moveToUcci(move),
      piece: { ...piece },
      captured: captured ? { ...captured } : null,
      fenBefore: toFen(before),
      fenAfter: toFen(after),
      check,
      notation,
    };

    this.records.push(record);
    this.current = after;
    this.keys.push(this.key(after));
    this.version += 1;
    return record;
  }

  moveUcci(text: string): MoveRecord {
    const move = moveFromText(this.current, text);
    if (!move) throw new Error(`Illegal or malformed UCCI move: ${text}`);
    return this.move(move);
  }

  undo(): MoveRecord | null {
    const record = this.records.pop();
    if (!record) return null;
    this.keys.pop();
    this.current = parseFen(record.fenBefore);
    this.resigned = null;
    this.version += 1;
    return record;
  }

  resign(color: Color): void {
    this.resigned = color;
    this.version += 1;
  }

  clone(): Game {
    const game = new Game(this.fen);
    for (const record of this.records) game.move(record.move);
    return game;
  }

  private key(position: Position): string {
    return boardKey(position);
  }

  private perpetualCheckSide(): Color | null {
    const recent = this.records.slice(-12);
    const redMoves = recent.filter(record => record.piece.color === 'w');
    const blackMoves = recent.filter(record => record.piece.color === 'b');
    const redAlwaysChecks = redMoves.length >= 2 && redMoves.every(record => record.check);
    const blackAlwaysChecks = blackMoves.length >= 2 && blackMoves.every(record => record.check);
    if (redAlwaysChecks && !blackAlwaysChecks) return 'w';
    if (blackAlwaysChecks && !redAlwaysChecks) return 'b';
    return null;
  }
}

export function statusForFen(fen: string): GameStatus {
  return evaluatePosition(parseFen(fen));
}

export function kingsFacingInFen(fen: string): boolean {
  return kingsFacing(parseFen(fen).board);
}

export function kingSquare(fen: string, color: Color) {
  return findKing(parseFen(fen).board, color);
}
