import type { AnalysisInfo } from './types.js';
import { PikafishError } from './types.js';

export function parseInfoLine(line: string): AnalysisInfo | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('info')) return null;
  const tokens = trimmed.split(/\s+/);
  const info: AnalysisInfo = { raw: trimmed };

  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    switch (token) {
      case 'depth':
        info.depth = toInt(tokens[++index]);
        break;
      case 'seldepth':
        info.seldepth = toInt(tokens[++index]);
        break;
      case 'multipv':
        info.multipv = toInt(tokens[++index]);
        break;
      case 'nodes':
        info.nodes = toInt(tokens[++index]);
        break;
      case 'nps':
        info.nps = toInt(tokens[++index]);
        break;
      case 'hashfull':
        info.hashfull = toInt(tokens[++index]);
        break;
      case 'tbhits':
        info.tbhits = toInt(tokens[++index]);
        break;
      case 'time':
        info.time = toInt(tokens[++index]);
        break;
      case 'currmove':
        info.currmove = tokens[++index];
        break;
      case 'currmovenumber':
        info.currmovenumber = toInt(tokens[++index]);
        break;
      case 'score': {
        const type = tokens[++index];
        const value = toInt(tokens[++index]);
        if ((type === 'cp' || type === 'mate') && Number.isFinite(value)) {
          const boundToken = tokens[index + 1];
          const bound =
            boundToken === 'lowerbound' || boundToken === 'upperbound'
              ? (boundToken === 'lowerbound' ? 'lower' : 'upper')
              : undefined;
          if (bound) index++;
          info.score = { type, value, ...(bound ? { bound } : {}) };
        }
        break;
      }
      case 'wdl': {
        const win = toInt(tokens[++index]);
        const draw = toInt(tokens[++index]);
        const loss = toInt(tokens[++index]);
        info.wdl = [win, draw, loss];
        break;
      }
      case 'pv': {
        info.pv = tokens.slice(index + 1);
        index = tokens.length;
        break;
      }
      case 'string': {
        info.string = tokens.slice(index + 1).join(' ');
        index = tokens.length;
        break;
      }
      default:
        break;
    }
  }
  return info;
}

export function parseBestmove(line: string): { bestmove: string; ponder?: string } | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'bestmove' || !tokens[1]) return null;
  const ponderIndex = tokens.indexOf('ponder');
  return {
    bestmove: tokens[1],
    ...(ponderIndex > 0 && tokens[ponderIndex + 1] ? { ponder: tokens[ponderIndex + 1] } : {}),
  };
}

export function validateFen(fen: string): void {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 2) throw new PikafishError('FEN must contain at least placement and side to move.', 'INVALID_FEN');
  const placement = parts[0]!;
  const ranks = placement.split('/');
  if (ranks.length !== 10) throw new PikafishError('Xiangqi FEN must contain 10 ranks.', 'INVALID_FEN');
  for (const rank of ranks) {
    let files = 0;
    for (const char of rank) {
      if (/[1-9]/.test(char)) files += Number(char);
      else if (/[kabnrcpKABNRCP]/.test(char)) files++;
      else throw new PikafishError(`Invalid FEN piece: ${char}`, 'INVALID_FEN');
    }
    if (files !== 9) throw new PikafishError('Every FEN rank must contain 9 files.', 'INVALID_FEN');
  }
  if (!/^[wb]$/.test(parts[1]!)) throw new PikafishError('FEN side to move must be w or b.', 'INVALID_FEN');
}

export function validateMove(move: string): void {
  if (!/^[a-i][0-9][a-i][0-9]$/.test(move)) {
    throw new PikafishError(`Invalid UCCI move: ${move}`, 'INVALID_MOVE');
  }
}

export function buildPositionCommand(fen: string, moves: string[] = []): string {
  validateFen(fen);
  for (const move of moves) validateMove(move);
  return `position fen ${fen}${moves.length ? ` moves ${moves.join(' ')}` : ''}`;
}

export function buildGoCommand(params: {
  depth?: number;
  movetime?: number;
  nodes?: number;
  infinite?: boolean;
  multiPV?: number;
  searchMoves?: string[];
}): string {
  const parts = ['go'];
  if (params.infinite) parts.push('infinite');
  if (params.depth != null) parts.push('depth', String(Math.max(1, Math.floor(params.depth))));
  if (params.movetime != null) parts.push('movetime', String(Math.max(1, Math.floor(params.movetime))));
  if (params.nodes != null) parts.push('nodes', String(Math.max(1, Math.floor(params.nodes))));
  // MultiPV is a UCI option, not a `go` parameter, so it is applied with
  // `setoption` before the search instead of being appended here.
  if (params.searchMoves?.length) parts.push('searchmoves', ...params.searchMoves);
  if (parts.length === 1) parts.push('infinite');
  return parts.join(' ');
}

export function formatOption(name: string, value: string | number | boolean): string {
  const normalized = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  if (/[\r\n]/.test(normalized)) throw new PikafishError('Option values cannot contain newlines.', 'INVALID_OPTION');
  return `setoption name ${name} value ${normalized}`;
}

function toInt(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
