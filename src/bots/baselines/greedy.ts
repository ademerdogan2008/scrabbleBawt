// Greedy baseline: bids round(1.5 * value + 2) capped at balance and cashes words immediately
// (repeat the highest-reward single word while one fits the rack).
import { VALUE, idx } from '../../core/letters.js';
import { rackClone } from '../../core/rack.js';
import type { Policy, PolicyFactory } from '../../core/types.js';
import { getEngine } from '../../engine/index.js';

export interface GreedyParams {
  bidMul: number;
  bidAdd: number;
  minLen: number;
}

export const GREEDY_DEFAULTS: Readonly<GreedyParams> = Object.freeze({ bidMul: 1.5, bidAdd: 2, minLen: 2 });

export const createGreedy: PolicyFactory = (_seed, opts) => {
  const p: GreedyParams = { ...GREEDY_DEFAULTS, ...(opts as Partial<GreedyParams> | undefined) };
  const { index } = getEngine();
  const policy: Policy = {
    name: 'greedy',
    onMatchStart() {},
    decide(view, auction) {
      const rack = rackClone(view.me.rack);
      const words: string[] = [];
      for (;;) {
        const w = index.bestSingleWord(rack, p.minLen);
        if (!w) break;
        words.push(w.word);
        for (let k = 0; k < w.word.length; k++) rack[w.word.charCodeAt(k) - 65]!--;
      }
      const value = VALUE[idx(auction.letter)] ?? 1;
      const bid = Math.max(0, Math.min(view.me.balance, Math.round(p.bidMul * value + p.bidAdd)));
      return { words, bid };
    },
  };
  return policy;
};
