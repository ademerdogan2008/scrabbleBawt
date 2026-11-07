// BlackSwan "liquidity floor" bidder (COMPETITORS.md §4.10 / §3.8). BlackSwan ships no license:
// re-implemented from the published description only.
//
//   bid = max(MCvalue x kappa, min(0.95 x price_L x phaseMult(progress), balance - reserve))
//   reserve = 40 while more than 12 auctions remain, else 0; in the last 7 the floor is x1.6.
//   Words: mid-match cash only 7+ letter words worth >= 38; dump the best partition in the last 2
//   auctions; bid 0 on the final tile.
//
// Approximations: price_L = ALLREAL median (the bot predates the sim-heavy lobby); "matchIndex" is
// read as Karthik's 17-bucket phase multiplier; MCvalue = mean fast-packing gain of the letter over
// 4 sampled futures of min(5, remaining/4) tiles (common random numbers).
import { NUM_LETTERS } from '../../core/letters.js';
import type { Rack } from '../../core/rack.js';
import type { Rng } from '../../core/rng.js';
import type { Policy, PolicyFactory } from '../../core/types.js';
import {
  ALLREAL_PRICE,
  Turn,
  fieldPhaseMult,
  letterOf,
  partitionFast,
  progressOf,
  rackPlus,
  topWords,
} from './common.js';

export interface BlackSwanParams {
  kappa: number;
  floorShare: number;
  reserve: number;
  reserveUntil: number;
  lateN: number;
  lateFloorMul: number;
  cashMinLen: number;
  cashMinReward: number;
  samples: number;
}

export const BLACKSWAN_DEFAULTS: Readonly<BlackSwanParams> = Object.freeze({
  kappa: 1,
  floorShare: 0.95,
  reserve: 40,
  reserveUntil: 12,
  lateN: 7,
  lateFloorMul: 1.6,
  cashMinLen: 7,
  cashMinReward: 38,
  samples: 4,
});

/** Mean fast-packing gain of letter li over sampled futures (shared by several zoo bots). */
export function mcLetterValue(rack: Rack, li: number, pool: Rack, k: number, samples: number, rng: Rng): number {
  const list: number[] = [];
  for (let i = 0; i < NUM_LETTERS; i++) for (let c = 0; c < pool[i]!; c++) list.push(i);
  const m = Math.min(Math.max(0, Math.floor(k)), list.length);
  let sum = 0;
  for (let s = 0; s < samples; s++) {
    const f = new Uint8Array(rack);
    for (let j = 0; j < m; j++) {
      const pick = j + rng.int(0, list.length - 1 - j);
      const tmp = list[j]!;
      list[j] = list[pick]!;
      list[pick] = tmp;
      f[list[j]!]!++;
    }
    sum += partitionFast(rackPlus(f, li)).score - partitionFast(f).score;
  }
  return samples > 0 ? Math.max(0, sum / samples) : 0;
}

export const createBlackSwan: PolicyFactory = (_seed, opts) => {
  const p: BlackSwanParams = { ...BLACKSWAN_DEFAULTS, ...(opts as Partial<BlackSwanParams> | undefined) };
  const policy: Policy = {
    name: 'clone:blackswan',
    onMatchStart() {},
    decide(view, auction, ctx) {
      const li = letterOf(auction);
      const T = auction.remainingAfter + 1;
      const t = new Turn(view);
      if (T <= 2) t.dump();
      else {
        for (const w of topWords(t.rack, p.cashMinLen, 1)) if (w.reward >= p.cashMinReward) t.play(w.word);
      }
      if (T <= 1) return t.decision(0);
      const k = Math.min(5, Math.floor(auction.remainingAfter / 4));
      const value = mcLetterValue(t.rack, li, view.unseen, k, p.samples, ctx.rng);
      const reserve = T > p.reserveUntil ? p.reserve : 0;
      let floor = p.floorShare * ALLREAL_PRICE[li]! * fieldPhaseMult(progressOf(view, auction));
      if (T <= p.lateN) floor *= p.lateFloorMul;
      const bid = Math.max(value * p.kappa, Math.min(floor, t.balance - reserve));
      return t.decision(bid);
    },
  };
  return policy;
};
