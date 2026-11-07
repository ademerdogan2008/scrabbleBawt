// trick:allin, the allin-bot spoiler (COMPETITORS.md §1 bot 151, §4.10; PITFALLS M2):
// never plays words; bids 1.5-2x the market on common letters (face <= maxFace) until broke
// (live: 16-26 on 1-pt letters, ~9 tiles/match). Market = ALLREAL median (16-22 on 1-pt letters).
import type { Policy, PolicyFactory } from '../../core/types.js';
import { ALLREAL_PRICE, VALUE, clampBid, letterOf } from '../clones/common.js';

export interface AllinParams {
  lo: number;
  hi: number;
  maxFace: number;
}

export const ALLIN_DEFAULTS: Readonly<AllinParams> = Object.freeze({ lo: 1.5, hi: 2, maxFace: 2 });

export const createAllin: PolicyFactory = (_seed, opts) => {
  const p: AllinParams = { ...ALLIN_DEFAULTS, ...(opts as Partial<AllinParams> | undefined) };
  const policy: Policy = {
    name: 'trick:allin',
    onMatchStart() {},
    decide(view, auction, ctx) {
      const li = letterOf(auction);
      const mult = p.lo + (p.hi - p.lo) * ctx.rng.float();
      if (VALUE[li]! > p.maxFace) return { words: [], bid: 0 };
      return { words: [], bid: clampBid(Math.round(ALLREAL_PRICE[li]! * mult), view.me.balance) };
    },
  };
  return policy;
};
