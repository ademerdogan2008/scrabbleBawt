// Server-side simulated bots, exactly as the module implements them
// (spacetimedb/src/game.ts decideBid / simulateBids / simulateWordPlay).
// Word choice for sims lives in engine/anagram.ts (findBestPlayable(rack, 3)).
import { IS_VOWEL, SIM_BID_JITTER, VALUE } from './letters.js';
import type { SimStrategy } from './types.js';

/** Base bid before jitter (module decideBid switch). */
export function simBaseBid(strategy: SimStrategy, letterIdx: number): number {
  const value = VALUE[letterIdx]!;
  switch (strategy) {
    case 'Human':
      return 0;
    case 'Cheapskate':
      return value - 1;
    case 'ValueBidder':
      return value;
    case 'Aggressive':
      return value + (IS_VOWEL[letterIdx] ? 4 : 2);
  }
}

/**
 * Exact module bid: max(min(max(base + jitter, 1), balance), 0); 'Human' bids 0.
 * `jitter` is drawn uniformly from -SIM_BID_JITTER..SIM_BID_JITTER (inclusive) for every
 * sim participant at every auction open, whether or not it can afford to bid.
 */
export function simBid(strategy: SimStrategy, letterIdx: number, balance: number, jitter: number): number {
  if (strategy === 'Human') return 0;
  const base = simBaseBid(strategy, letterIdx);
  return Math.max(Math.min(Math.max(base + jitter, 1), balance), 0);
}

/** Probability mass of a sim's bid: returns [amount, probability] pairs (amount 0 = no bid). */
export function simBidDistribution(
  strategy: SimStrategy,
  letterIdx: number,
  balance: number,
): Array<[number, number]> {
  const out = new Map<number, number>();
  const n = 2 * SIM_BID_JITTER + 1;
  for (let j = -SIM_BID_JITTER; j <= SIM_BID_JITTER; j++) {
    const b = simBid(strategy, letterIdx, balance, j);
    out.set(b, (out.get(b) ?? 0) + 1 / n);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]);
}

/** Highest bid this sim can possibly make for the letter (upper bound used for safe overbids). */
export function simMaxBid(strategy: SimStrategy, letterIdx: number, balance: number): number {
  return simBid(strategy, letterIdx, balance, SIM_BID_JITTER);
}

export function parseSimStrategy(tag: string): SimStrategy | undefined {
  switch (tag.toLowerCase()) {
    case 'cheapskate':
      return 'Cheapskate';
    case 'valuebidder':
      return 'ValueBidder';
    case 'aggressive':
      return 'Aggressive';
    case 'human':
      return 'Human';
    default:
      return undefined;
  }
}
