import { describe, expect, it } from 'vitest';
import { parseBestmove, parseInfoLine, validateFen, validateMove } from '../src/uci.ts';
import { buildGoCommand, buildPositionCommand, formatOption } from '../src/uci.ts';
import { PikafishError } from '../src/types.ts';

const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

describe('parseInfoLine', () => {
  it('parses depth, score, nodes and the principal variation', () => {
    const info = parseInfoLine(
      'info depth 12 seldepth 18 multipv 1 score cp 34 nodes 12345 nps 750000 time 16 pv h2e2 h7e7',
    );
    expect(info).not.toBeNull();
    expect(info?.depth).toBe(12);
    expect(info?.seldepth).toBe(18);
    expect(info?.multipv).toBe(1);
    expect(info?.score).toEqual({ type: 'cp', value: 34 });
    expect(info?.nodes).toBe(12345);
    expect(info?.nps).toBe(750000);
    expect(info?.pv).toEqual(['h2e2', 'h7e7']);
  });

  it('records mate scores and bounds', () => {
    const mate = parseInfoLine('info depth 6 score mate -3 pv e0e1');
    expect(mate?.score).toEqual({ type: 'mate', value: -3 });

    const bound = parseInfoLine('info depth 4 score cp 12 upperbound pv b0c2');
    expect(bound?.score).toEqual({ type: 'cp', value: 12, bound: 'upper' });
  });

  it('ignores non-info lines', () => {
    expect(parseInfoLine('bestmove h2e2')).toBeNull();
    expect(parseInfoLine('readyok')).toBeNull();
  });
});

describe('parseBestmove', () => {
  it('parses bestmove with and without ponder', () => {
    expect(parseBestmove('bestmove h2e2 ponder h7e7')).toEqual({
      bestmove: 'h2e2',
      ponder: 'h7e7',
    });
    expect(parseBestmove('bestmove (none)')).toEqual({ bestmove: '(none)' });
    expect(parseBestmove('info depth 1')).toBeNull();
  });
});

describe('command builders', () => {
  it('builds position commands with moves', () => {
    expect(buildPositionCommand(START_FEN)).toBe(`position fen ${START_FEN}`);
    expect(buildPositionCommand(START_FEN, ['h2e2', 'h7e7'])).toBe(
      `position fen ${START_FEN} moves h2e2 h7e7`,
    );
  });

  it('builds go commands and defaults to infinite', () => {
    expect(buildGoCommand({ depth: 12 })).toBe('go depth 12');
    expect(buildGoCommand({ movetime: 1500, searchMoves: ['h2e2'] })).toBe(
      'go movetime 1500 searchmoves h2e2',
    );
    expect(buildGoCommand({})).toBe('go infinite');
    expect(buildGoCommand({ infinite: true })).toBe('go infinite');
  });

  it('formats options and rejects newlines', () => {
    expect(formatOption('Threads', 4)).toBe('setoption name Threads value 4');
    expect(formatOption('UCI_ShowWDL', true)).toBe('setoption name UCI_ShowWDL value true');
    expect(() => formatOption('EvalFile', 'a\nb')).toThrow(PikafishError);
  });
});

describe('validation', () => {
  it('accepts a legal FEN and rejects malformed ones', () => {
    expect(() => validateFen(START_FEN)).not.toThrow();
    expect(() => validateFen('9/9/9/9/9/9/9/9/9 w - - 0 1')).toThrow(PikafishError);
    expect(() =>
      validateFen('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR x - - 0 1'),
    ).toThrow(PikafishError);
  });

  it('accepts UCCI moves and rejects everything else', () => {
    expect(() => validateMove('h2e2')).not.toThrow();
    expect(() => validateMove('a0a1')).not.toThrow();
    expect(() => validateMove('h2e')).toThrow(PikafishError);
    expect(() => validateMove('j2e2')).toThrow(PikafishError);
    expect(() => validateMove('i2e2')).not.toThrow();
    expect(() => validateMove('H2E2')).toThrow(PikafishError);
  });
});
