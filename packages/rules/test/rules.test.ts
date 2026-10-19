import { describe, expect, it } from 'vitest';
import {
  Game,
  START_FEN,
  applyMove,
  generateLegalMoves,
  isKingInCheck,
  parseFen,
  parseUcci,
  startPosition,
  toFen,
  toChineseNotation,
} from '../src/index.ts';

function perft(fen: string, depth: number): number {
  const position = parseFen(fen);
  if (depth === 0) return 1;
  let nodes = 0;
  for (const move of generateLegalMoves(position)) {
    nodes += perft(toFen(applyMove(position, move)), depth - 1);
  }
  return nodes;
}

describe('FEN', () => {
  it('round-trips the start position', () => {
    expect(toFen(parseFen(START_FEN))).toBe(START_FEN);
  });

  it('maps ranks so Red home is rank 0', () => {
    const position = startPosition();
    expect(position.board[0]?.[4]).toEqual({ color: 'w', type: 'k' });
    expect(position.board[9]?.[4]).toEqual({ color: 'b', type: 'k' });
    expect(position.board[2]?.[1]).toEqual({ color: 'w', type: 'c' });
  });

  it('rejects malformed FEN', () => {
    expect(() => parseFen('9/9/9/9/9/9/9/9/9 w - - 0 1')).toThrow();
  });
});

describe('move generation', () => {
  it('has 44 legal moves at the start', () => {
    expect(generateLegalMoves(startPosition())).toHaveLength(44);
  });

  it('matches known perft values', () => {
    expect(perft(START_FEN, 1)).toBe(44);
    expect(perft(START_FEN, 2)).toBe(1920);
    expect(perft(START_FEN, 3)).toBe(79666);
  });

  it('understands horse legs', () => {
    const position = parseFen(
      'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/1R7/RNBAKABNR w - - 0 1',
    );
    // The red horse on b0 is blocked by the red rook on b1.
    expect(
      generateLegalMoves(position).some(
        move => move.from.file === 1 && move.from.rank === 0 && move.to.rank === 2,
      ),
    ).toBe(false);
  });

  it('rejects moves that expose the king', () => {
    const position = parseFen('4k4/9/9/9/9/9/9/9/4r4/4K4 w - - 0 1');
    const king = { file: 4, rank: 0 };
    const moves = generateLegalMoves(position).filter(move => move.from.file === king.file && move.from.rank === king.rank);
    expect(moves.every(move => move.to.file !== 3)).toBe(false);
    expect(isKingInCheck(position, 'w')).toBe(true);
  });
});

describe('game rules', () => {
  it('detects checkmate', () => {
    const game = new Game('4k4/9/9/9/9/9/9/9/3RRR3/4K4 b - - 0 1');
    const status = game.status();
    expect(status.over).toBe(true);
    expect(status.reason).toBe('checkmate');
    expect(status.result).toBe('red');
  });

  it('detects stalemate as a loss in xiangqi', () => {
    const game = new Game('4k4/9/4P4/9/9/9/9/9/3R1R3/4K4 b - - 0 1');
    const status = game.status();
    expect(status.over).toBe(true);
    expect(status.reason).toBe('stalemate');
    expect(status.result).toBe('red');
  });

  it('plays and undoes moves', () => {
    const game = new Game(START_FEN);
    const record = game.moveUcci('h2e2');
    expect(record.notation).toContain('炮');
    expect(game.turn).toBe('b');
    game.undo();
    expect(game.fen).toBe(START_FEN);
  });

  it('detects the 120-halfmove draw', () => {
    const game = new Game('4k4/9/9/9/9/9/9/9/R8/4K4 w - - 120 1');
    expect(game.status().reason).toBe('sixty-move');
  });

  it('detects insufficient material', () => {
    const game = new Game('4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1');
    expect(game.status().reason).toBe('insufficient');
  });
});

describe('notation', () => {
  it('writes the opening cannon move', () => {
    const position = startPosition();
    const move = parseUcci('h2e2')!;
    expect(toChineseNotation(position, move)).toBe('炮二平五');
  });

  it('writes a horse move', () => {
    const position = startPosition();
    const move = parseUcci('b0c2')!;
    expect(toChineseNotation(position, move)).toBe('马八进七');
  });
});
