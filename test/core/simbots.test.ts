import { describe, expect, it } from 'vitest';
import { idx } from '../../src/core/letters.js';
import { parseSimStrategy, simBaseBid, simBid, simBidDistribution, simMaxBid } from '../../src/core/simbots.js';

// Literal port of the module's decideBid with BigInt to cross-check.
function moduleDecideBid(strategy: string, letter: string, balance: bigint, jitter: bigint): bigint {
  const values: Record<string, bigint> = {
    A: 1n, E: 1n, I: 1n, O: 1n, U: 1n, L: 1n, N: 1n, S: 1n, T: 1n, R: 1n, D: 2n, G: 2n,
    B: 3n, C: 3n, M: 3n, P: 3n, F: 4n, H: 4n, V: 4n, W: 4n, Y: 4n, K: 5n, J: 8n, X: 8n, Q: 10n, Z: 10n,
  };
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  const value = values[letter]!;
  const isVowel = 'AEIOU'.includes(letter);
  let base: bigint;
  switch (strategy) {
    case 'Human':
      return 0n;
    case 'Cheapskate':
      base = value - 1n;
      break;
    case 'ValueBidder':
      base = value;
      break;
    default:
      base = value + (isVowel ? 4n : 2n);
  }
  return max(min(max(base + jitter, 1n), balance), 0n);
}

describe('sim bots', () => {
  it('match the module decideBid for every letter, strategy, jitter and balance 0..40', () => {
    for (const strat of ['Cheapskate', 'ValueBidder', 'Aggressive', 'Human'] as const) {
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        for (let bal = 0; bal <= 40; bal++) {
          for (let j = -2; j <= 2; j++) {
            expect(simBid(strat, idx(letter), bal, j)).toBe(
              Number(moduleDecideBid(strat, letter, BigInt(bal), BigInt(j))),
            );
          }
        }
      }
    }
  });

  it('base bids, max bid and distribution', () => {
    expect(simBaseBid('Aggressive', idx('E'))).toBe(5);
    expect(simBaseBid('Aggressive', idx('T'))).toBe(3);
    expect(simBaseBid('Cheapskate', idx('Q'))).toBe(9);
    expect(simMaxBid('Aggressive', idx('A'), 100)).toBe(7);
    expect(simMaxBid('Aggressive', idx('A'), 4)).toBe(4);
    const d = simBidDistribution('Cheapskate', idx('E'), 100);
    // base 0: jitter -2..2 -> max(..,1) => 1,1,1,1,2
    expect(d).toEqual([
      [1, 0.8],
      [2, 0.2],
    ].map(([a, p]) => [a, expect.closeTo(p!, 10)]));
    expect(simBidDistribution('ValueBidder', idx('Z'), 0)).toEqual([[0, expect.closeTo(1, 10)]]);
    expect(parseSimStrategy('aggressive')).toBe('Aggressive');
    expect(parseSimStrategy('nope')).toBeUndefined();
  });
});
