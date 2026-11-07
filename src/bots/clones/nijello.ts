// Nijello gen-180 clone (COMPETITORS.md §4.4: bananatruck src/strategy.ts + params/nijello-live.json).
// Re-implemented from the spec (the upstream repos ship no license; nothing copied).
//
// Approximation: the live bot may replace its bid in the last 12 auctions with a 450 ms MC
// look-ahead; like Karthik's field model we use bid x exp(0.25 z) there instead.
// Option seatScale (3nvyx variant): budget x (N < 6 ? sqrt(N/6) : N/6). Off by default (bananatruck).
import { IS_VOWEL, NUM_LETTERS, VALUE, idx } from '../../core/letters.js';
import type { Rack } from '../../core/rack.js';
import type { Policy, PolicyFactory } from '../../core/types.js';
import {
  Turn,
  bestRewardCached,
  gauss,
  letterOf,
  partition,
  rackMinusWord,
  rackPlus,
  rackSize,
  topWords,
  vowelCount,
} from './common.js';

const KEEP_STR =
  'A8.85 B3.12 C4.36 D5.39 E9.60 F3.85 G1.30 H5.93 I7.22 J2.19 K7.42 L4.62 M4.54 N5.54 O7.78 P4.43 Q3.27 R7.59 S6.87 T4.74 U7.51 V1.05 W3.58 X3.95 Y7.02 Z9.24';
export const NIJELLO_KEEP: readonly number[] = (() => {
  const out = new Array<number>(NUM_LETTERS).fill(0);
  for (const tok of KEEP_STR.split(' ')) out[idx(tok[0]!)] = Number(tok.slice(1));
  return Object.freeze(out);
})();

export interface NijelloParams {
  vowelTarget: number;
  vowelW: number;
  dupW: number;
  qNoU: number;
  scarceW: number;
  wB: number;
  tau: number;
  denyW: number;
  c0: number;
  c1: number;
  fpShade: number;
  holdW: number;
  cashW: number;
  cashScale: number;
  playThresh: number;
  endN: number;
  wFlush: number;
  spendW: number;
  endCash: number;
  lateNoiseSd: number;
  lateNoiseN: number;
  seatScale: boolean;
}

export const NIJELLO_DEFAULTS: Readonly<NijelloParams> = Object.freeze({
  vowelTarget: 0.3832,
  vowelW: 1.1091,
  dupW: 2.5118,
  qNoU: 11.458,
  scarceW: 5.7008,
  wB: 0.3328,
  tau: 0.5,
  denyW: 3.0606,
  c0: 0.2024,
  c1: 0.3003,
  fpShade: 0.7975,
  holdW: 0.8834,
  cashW: 4,
  cashScale: 3,
  playThresh: 25,
  endN: 6.4139,
  wFlush: 0.9077,
  spendW: 1.5675,
  endCash: 10.5215,
  lateNoiseSd: 0.25,
  lateNoiseN: 12,
  seatScale: false,
});

const Q = idx('Q');
const U = idx('U');

/** Nijello rack-quality Q(r). `unseenU` = unseen copies of U. */
export function nijelloQ(r: Rack, unseenU: number, p: NijelloParams): number {
  let s = 0;
  let dup = 0;
  for (let i = 0; i < NUM_LETTERS; i++) {
    const n = r[i]!;
    s += NIJELLO_KEEP[i]! * n;
    if (n > 1) dup += (n - 1) * (n - 1);
  }
  const size = rackSize(r);
  s -= p.vowelW * Math.abs(vowelCount(r) - p.vowelTarget * size);
  s -= p.dupW * dup;
  if (r[Q]! >= 1 && r[U]! === 0 && unseenU === 0) s -= p.qNoU;
  return s;
}

export const createNijello: PolicyFactory = (_seed, opts) => {
  const p: NijelloParams = { ...NIJELLO_DEFAULTS, ...(opts as Partial<NijelloParams> | undefined) };
  const policy: Policy = {
    name: 'clone:nijello',
    onMatchStart() {},
    decide(view, auction, ctx) {
      const li = letterOf(auction);
      const B = auction.remainingAfter;
      const t = new Turn(view);
      if (B === 0) {
        t.dump();
        return t.decision(0);
      }
      const unseen = view.unseen;
      const unseenU = unseen[U]!;
      const ph = B / (B + p.tau);
      // ---- words (chooseWords)
      const minLen = B <= p.endN && t.balance >= p.endCash ? 7 : 2;
      for (let k = 0; k < 4; k++) {
        const qNow = nijelloQ(t.rack, unseenU, p);
        let bestNet = -Infinity;
        let bestW: string | undefined;
        for (const w of topWords(t.rack, minLen, 24)) {
          const qRest = nijelloQ(rackMinusWord(t.rack, w.word), unseenU, p);
          const net =
            w.reward * (1 + (p.cashW * p.cashScale) / (p.cashScale + t.balance)) - p.holdW * ph * (qNow - qRest);
          if (net > bestNet) {
            bestNet = net;
            bestW = w.word;
          }
        }
        if (bestW === undefined || bestNet <= p.playThresh) break;
        t.play(bestW);
      }
      // ---- value
      const r = t.rack;
      const rL = rackPlus(r, li);
      let U_tot = 0;
      let U_vow = 0;
      for (let i = 0; i < NUM_LETTERS; i++) {
        U_tot += unseen[i]!;
        if (IS_VOWEL[i]) U_vow += unseen[i]!;
      }
      let value =
        ph * (nijelloQ(rL, unseenU, p) - nijelloQ(r, unseenU, p)) +
        p.wB * (bestRewardCached(rL, 2) - bestRewardCached(r, 2)) +
        p.denyW * VALUE[li]! * ph +
        (IS_VOWEL[li] ? 1 : -1) * p.scarceW * (p.vowelTarget - (U_tot > 0 ? U_vow / U_tot : p.vowelTarget)) * ph;
      if (li === Q && r[U]! === 0 && unseenU === 0) value = Math.min(value, 0);
      if (B <= p.endN) value = Math.max(value, p.wFlush * (partition(rL).score - partition(r).score));
      // ---- bid
      if (value <= 0 || t.balance <= 0) return t.decision(0);
      if (B === 1) return t.decision(t.balance);
      let budget = t.balance / (B + 1);
      if (p.seatScale) {
        const N = view.config.players.length;
        budget *= N < 6 ? Math.sqrt(N / 6) : N / 6;
      }
      let mult = Math.exp(p.c0) * (budget / 3) ** p.c1;
      if (B <= p.endN) mult *= 1 + (p.spendW * (p.endN + 1 - B)) / (p.endN + 1);
      if (B <= p.lateNoiseN) mult *= Math.exp(p.lateNoiseSd * gauss(ctx.rng));
      const shade = view.config.auctionType === 'FirstPrice' ? p.fpShade : 1;
      return t.decision(Math.min(value * mult * shade, t.balance));
    },
  };
  return policy;
};
