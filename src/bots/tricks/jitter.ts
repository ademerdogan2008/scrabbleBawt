// trick:jitter, a truthful-ish bidder with ±30% multiplicative noise (LetterSharkUltra "jitter";
// COMPETITORS §7: noisy bids defeat valuation inversion via the top-bid leak). Truth = gaucho's
// linear bid on a Monte Carlo marginal value (util.truthfulBid). Words: 7+ on sight, dump at T <= 2.
// Final tile: 0.
import type { Policy, PolicyFactory } from '../../core/types.js';
import { Turn } from '../clones/common.js';
import { standardWords, truthfulBid } from './util.js';

export interface JitterParams {
  noise: number;
}

export const JITTER_DEFAULTS: Readonly<JitterParams> = Object.freeze({ noise: 0.3 });

export const createJitter: PolicyFactory = (_seed, opts) => {
  const p: JitterParams = { ...JITTER_DEFAULTS, ...(opts as Partial<JitterParams> | undefined) };
  const policy: Policy = {
    name: 'trick:jitter',
    onMatchStart() {},
    decide(view, auction, ctx) {
      const t = new Turn(view);
      const m = 1 - p.noise + 2 * p.noise * ctx.rng.float();
      standardWords(t, auction);
      if (auction.remainingAfter === 0) return t.decision(0);
      return t.decision(truthfulBid(view, auction, t, ctx.rng) * m);
    },
  };
  return policy;
};
