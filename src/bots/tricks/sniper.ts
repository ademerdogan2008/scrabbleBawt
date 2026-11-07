// trick:sniper (LetterSharkUltra "sniper"; SookraBot SIM_ONLY; PITFALLS "RNG exploiter" warning
// sign "wins at simMax + 1"). Sims bid face-based with jitter <= 2, so their maximum possible bid
// is computable from public data. When only sims compete (every real rival is broke, i.e. its
// balance <= that sim maximum, or there is no real rival) and the letter has value to the sniper,
// it bids exactly simMax + 1 and wins for sure; otherwise it bids low: min(face + 1, truthful).
// Words: 7+ on sight, dump at T <= 2. Final tile: 0.
import type { Policy, PolicyFactory } from '../../core/types.js';
import { Turn, VALUE, letterOf, maxSimBid, rackPlus } from '../clones/common.js';
import { sookraPackValue } from '../clones/sookra.js';
import { standardWords, truthfulBid } from './util.js';

export const createSniper: PolicyFactory = () => {
  const policy: Policy = {
    name: 'trick:sniper',
    onMatchStart() {},
    decide(view, auction, ctx) {
      const li = letterOf(auction);
      const t = new Turn(view);
      standardWords(t, auction);
      if (auction.remainingAfter === 0) return t.decision(0);
      const simMax = maxSimBid(view, li);
      const onlySims = view.opponents.every((o) => o.info.isSim || o.balance <= simMax);
      const useful = sookraPackValue(rackPlus(t.rack, li), 0.35) - sookraPackValue(t.rack, 0.35) > 2;
      if (onlySims && useful) return t.decision(simMax + 1);
      return t.decision(Math.min(VALUE[li]! + 1, truthfulBid(view, auction, t, ctx.rng)));
    },
  };
  return policy;
};
