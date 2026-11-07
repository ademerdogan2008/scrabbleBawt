// Random baseline: uniform bid in [0, min(balance, 3 * value + 5)] from ctx.rng; with probability
// 0.3 per decide it plays one random word from a random anagram class that fits the rack.
import { VALUE, idx } from '../../core/letters.js';
import type { Policy, PolicyFactory } from '../../core/types.js';
import { getEngine } from '../../engine/index.js';

export interface RandomParams {
  playProb: number;
  bidMul: number;
  bidAdd: number;
}

export const RANDOM_DEFAULTS: Readonly<RandomParams> = Object.freeze({ playProb: 0.3, bidMul: 3, bidAdd: 5 });

export const createRandom: PolicyFactory = (_seed, opts) => {
  const p: RandomParams = { ...RANDOM_DEFAULTS, ...(opts as Partial<RandomParams> | undefined) };
  const { index, dict } = getEngine();
  const policy: Policy = {
    name: 'random',
    onMatchStart() {},
    decide(view, auction, ctx) {
      const value = VALUE[idx(auction.letter)] ?? 1;
      const cap = Math.max(0, Math.min(view.me.balance, Math.floor(p.bidMul * value + p.bidAdd)));
      const bid = ctx.rng.int(0, cap);
      const words: string[] = [];
      if (ctx.rng.float() < p.playProb) {
        const classes = index.subClasses(view.me.rack, 2);
        if (classes.length > 0) words.push(ctx.rng.pick(dict.classWords(ctx.rng.pick(classes))));
      }
      return { words, bid };
    },
  };
  return policy;
};
