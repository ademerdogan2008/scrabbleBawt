// trick:late, hoard coins, then dominate the last `window` auctions (LetterSharkUltra "late";
// PITFALLS M4 end-game money dumps). Before the window it bids 0 and plays nothing. Inside the
// window (B + 1 <= window, excluding the final tile) it bids
//   min(balance, max(2 x NOW market, ceil(spread x balance / B)))
// on every letter, cashes 6+ letter words on sight and dumps the exact best partition at T <= 2.
import type { Policy, PolicyFactory } from '../../core/types.js';
import { NOW_PRICE, Turn, cashGreedy, letterOf } from '../clones/common.js';

export interface LateParams {
  window: number;
  spread: number;
  minLen: number;
}

export const LATE_DEFAULTS: Readonly<LateParams> = Object.freeze({ window: 15, spread: 2, minLen: 6 });

export const createLate: PolicyFactory = (_seed, opts) => {
  const p: LateParams = { ...LATE_DEFAULTS, ...(opts as Partial<LateParams> | undefined) };
  const policy: Policy = {
    name: 'trick:late',
    onMatchStart() {},
    decide(view, auction) {
      const li = letterOf(auction);
      const B = auction.remainingAfter;
      const T = B + 1;
      const t = new Turn(view);
      if (T <= 2) t.dump();
      else if (T <= p.window) t.playAll(cashGreedy(t.rack, p.minLen, 4));
      if (B === 0 || T > p.window) return t.decision(0);
      return t.decision(Math.max(2 * NOW_PRICE[li]!, Math.ceil((p.spread * t.balance) / B)));
    },
  };
  return policy;
};
