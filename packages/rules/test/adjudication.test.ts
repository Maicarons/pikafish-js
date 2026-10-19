import { describe, expect, it } from 'vitest';
import { Game, parseFen } from '../src/index.js';

// Chinese rules only end a game on repetition when one side is repeating a
// check; anything else is a draw. These positions are built so the cycle is
// unambiguous and the only pieces that move are a rook and a bare king.

describe('repetition', () => {
  // Red rook a0 <-> a1, Black rook i9 <-> i8. After four plies the exact same
  // position with Red to move is on the board again.
  const SHUFFLE = '3k4r/9/9/9/9/9/9/9/9/R4K3 w - - 0 1';
  const CYCLE = ['a0a1', 'i9i8', 'a1a0', 'i8i9'];

  it('counts the starting position once', () => {
    expect(new Game(SHUFFLE).repetitionCount()).toBe(1);
  });

  it('is still playable after the second occurrence', () => {
    const game = new Game(SHUFFLE);
    for (const ucci of CYCLE) game.moveUcci(ucci);

    expect(game.repetitionCount()).toBe(2);
    expect(game.status()).toMatchObject({ over: false, result: null, reason: null });
  });

  it('is a draw on the third occurrence', () => {
    const game = new Game(SHUFFLE);
    for (let cycle = 0; cycle < 2; cycle += 1) {
      for (const ucci of CYCLE) game.moveUcci(ucci);
    }

    expect(game.repetitionCount()).toBe(3);
    expect(game.status()).toMatchObject({ over: true, result: 'draw', reason: 'repetition' });
  });

  it('forgets the repetition when a move is taken back', () => {
    const game = new Game(SHUFFLE);
    for (let cycle = 0; cycle < 2; cycle += 1) {
      for (const ucci of CYCLE) game.moveUcci(ucci);
    }
    game.undo();

    expect(game.repetitionCount()).toBe(2);
    expect(game.status().over).toBe(false);
  });

  it('does not count a position reached with the other side to move', () => {
    // Only the Black rook moves, so the position never repeats with the same
    // side to move and the counter stays at one.
    const game = new Game(SHUFFLE);
    game.moveUcci('a0a1');
    const afterRed = game.repetitionCount();
    game.moveUcci('i9i8');
    game.moveUcci('a1a0');
    game.moveUcci('i8i9');

    expect(afterRed).toBe(1);
    expect(game.repetitionCount()).toBe(2);
  });
});

describe('perpetual check', () => {
  // The rook checks from the eighth rank, the bare king steps up, the rook
  // checks from the ninth, the king steps back. Red never varies the check, so
  // Red loses rather than the game being drawn.
  const CHECK_CYCLE = ['a9a8', 'e8e9', 'a8a9', 'e9e8'];
  const POSITION = 'R8/4k4/9/9/9/9/9/9/9/5K3 w - - 0 1';

  it('records every checking move as a check', () => {
    const game = new Game(POSITION);
    const record = game.moveUcci('a9a8');

    expect(record.check).toBe(true);
    expect(record.notation.endsWith('+')).toBe(true);
  });

  it('awards the game to the side that is being checked forever', () => {
    const game = new Game(POSITION);
    for (let cycle = 0; cycle < 2; cycle += 1) {
      for (const ucci of CHECK_CYCLE) game.moveUcci(ucci);
    }

    expect(game.status()).toMatchObject({
      over: true,
      result: 'black',
      reason: 'perpetual-check',
    });
  });
});

describe('defensive input handling', () => {
  it('rejects malformed FEN instead of building a broken board', () => {
    const malformed = [
      '',
      'not a fen',
      '9/9/9 w',
      // Eleven ranks.
      'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/9/RNBAKABNR w - - 0 1',
      // Side to move is not w/b.
      'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR x - - 0 1',
      // Markup must be rejected, never echoed back into the page.
      '<script>alert(1)</script>',
    ];

    for (const fen of malformed) {
      expect(() => parseFen(fen), fen).toThrow();
    }
  });

  it('rejects malformed and illegal UCCI moves', () => {
    const game = new Game();

    expect(() => game.moveUcci('')).toThrow();
    expect(() => game.moveUcci('z9z9')).toThrow();
    expect(() => game.moveUcci('a0a1a2')).toThrow();
    // The a-file is blocked by the Red pawn on a3.
    expect(() => game.moveUcci('a0a9')).toThrow();
    // Black cannot move on Red's turn.
    expect(() => game.moveUcci('i9i8')).toThrow();

    expect(game.history).toHaveLength(0);
  });

  it('rejects a move from an empty square and a blocked move', () => {
    const game = new Game();

    // Legality is checked first, so an empty source square is "illegal" too.
    expect(() => game.move({ from: { file: 4, rank: 4 }, to: { file: 4, rank: 5 } })).toThrow(
      /Illegal/,
    );
    expect(() => game.move({ from: { file: 0, rank: 0 }, to: { file: 0, rank: 3 } })).toThrow(
      /Illegal/,
    );
  });

  it('refuses to keep playing once the game is over', () => {
    const game = new Game();
    game.resign('w');

    expect(game.status()).toMatchObject({ over: true, result: 'black', reason: 'resign' });
    expect(() => game.moveUcci('b2e2')).toThrow(/over/);
  });
});
