// ZOO-04 hoarder / random / bottom-feeder entries as thin wrappers of the 02-01 baselines
// (src/bots/baselines/** is not modified or copied).
//
// trick:hoarder      = baseline hoarder bids; its flush is recomputed here with the bounded exact
//                      partition (node + time limit) because the baseline's unbounded packExact
//                      peaked at 461.7 ms on a 20+ tile rack (02-01 follow-up). The baseline's
//                      decide() is called with remainingAfter masked so it never runs its own flush.
// trick:random       = the random baseline under the trick name.
// trick:bottomFeeder = the greedy baseline parametrized to bid exactly 1 on every letter
//                      (bidMul 0, bidAdd 1) while cashing greedy words (PITFALLS M3).
import type { Policy, PolicyFactory } from '../../core/types.js';
import { HOARDER_DEFAULTS, createGreedy, createHoarder, createRandom, type HoarderParams } from '../baselines/index.js';
import { Turn } from '../clones/common.js';
import { renamed } from './util.js';

export const createTrickHoarder: PolicyFactory = (seed, opts) => {
  const inner = createHoarder(seed, opts);
  const flushAt = ((opts as Partial<HoarderParams> | undefined)?.flushAt ?? HOARDER_DEFAULTS.flushAt) as number;
  const policy: Policy = {
    name: 'trick:hoarder',
    onMatchStart: (v) => inner.onMatchStart(v),
    decide(view, auction, ctx) {
      const d = inner.decide(view, { ...auction, remainingAfter: Number.MAX_SAFE_INTEGER }, ctx);
      const t = new Turn(view);
      if (auction.remainingAfter <= flushAt) t.dump();
      return t.decision(d.bid);
    },
  };
  return policy;
};

export const createTrickRandom: PolicyFactory = (seed, opts) => renamed(createRandom(seed, opts), 'trick:random');

export const createBottomFeeder: PolicyFactory = (seed, opts) =>
  renamed(createGreedy(seed, { bidMul: 0, bidAdd: 1, ...opts }), 'trick:bottomFeeder');
