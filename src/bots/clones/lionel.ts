// Lionel / gaucho clone (COMPETITORS.md §4.3, params/vickrey.json VERSION 2026-10-25-selfarena).
// Re-implemented from the spec; no code copied.
//
// Approximations (documented):
//   * pot(rack) = max over words w (len >= 3, <= min(2, A) missing tiles, need <= unseen) of
//     reward(w) * PROD pc[missing]. Evaluated as max over extension multisets E (|E| <= 2) of
//     best(rack + E) * PROD_{e in E} pc[e]: a word missing exactly M is scored with its exact weight
//     at E = M and with a smaller weight at any larger E, so the max is exact for |E| <= 1 and for
//     pairs drawn from the PAIR_TOP letters with the highest pc (all pairs would be 351 lookups).
//   * unseen = the tracker's unseen (also removes opponents' revealed start tiles; gaucho does not).
//   * market[L][q]: gaucho's Oct-24 quintile table is not public beyond A (11,10,10,11,12) and
//     Z (45,45,38,32,19). We use ALLREAL median x a quintile shape interpolated by face value
//     between A's shape (face 1) and Z's shape (face 10).
import { NUM_LETTERS, VALUE } from '../../core/letters.js';
import type { Rack } from '../../core/rack.js';
import type { MatchView, Policy, PolicyFactory } from '../../core/types.js';
import {
  ALLREAL_PRICE,
  Turn,
  bestRewardCached,
  bestWord,
  clamp,
  letterOf,
  partition,
  rackMinusWord,
  rackPlus,
  rackSize,
} from './common.js';

export interface LionelParams {
  pBase: number;
  aHalf: number;
  maxMissing: number;
  minLen: number;
  alpha: number;
  beta: number;
  gamma: number;
  pace: number;
  shade: number;
  holdKappa: number;
  minPlayReward: number;
  /** Dump the exact best partition when A <= flushAt. */
  flushAt: number;
  lowCash: number;
  floorMult: number;
  letterTarget: number;
  slack: number;
  horizonW: number;
  idleBeta: number;
  endN: number;
  c0: number;
  c1: number;
  denyW: number;
  /** Letters (by pc) whose pairs are enumerated for 2-missing words. */
  pairTop: number;
}

export const LIONEL_DEFAULTS: Readonly<LionelParams> = Object.freeze({
  pBase: 0.95,
  aHalf: 0.374,
  maxMissing: 2,
  minLen: 3,
  alpha: 0.969,
  beta: 1.536,
  gamma: 1.919,
  pace: 0.83,
  shade: 0.552,
  holdKappa: 0.66,
  minPlayReward: 40.551,
  flushAt: 1,
  lowCash: 9.467,
  floorMult: 0.796,
  letterTarget: 12.016,
  slack: 1.996,
  horizonW: 1.172,
  idleBeta: 0.839,
  endN: 2,
  c0: 0.472,
  c1: 0.215,
  denyW: 0.077,
  pairTop: 8,
});

const A_SHAPE = [11, 10, 10, 11, 12].map((x) => x / 10.8);
const Z_SHAPE = [45, 45, 38, 32, 19].map((x) => x / 35.8);

/** Approximate gaucho market[L][quintile] (see header). */
export function lionelMarket(li: number, q: number): number {
  const t = clamp((VALUE[li]! - 1) / 9, 0, 1);
  return ALLREAL_PRICE[li]! * (A_SHAPE[q]! * (1 - t) + Z_SHAPE[q]! * t);
}

/** gaucho pot(): probability-weighted best word reachable with <= maxMissing more tiles. */
export function lionelPot(rack: Rack, unseen: Rack, A: number, p: LionelParams): number {
  let U = 0;
  for (let i = 0; i < NUM_LETTERS; i++) U += unseen[i]!;
  const f = clamp(U > 0 ? A / U : 1, 0.02, 1);
  const aH = p.aHalf / f ** p.horizonW;
  const pc = new Float64Array(NUM_LETTERS);
  for (let i = 0; i < NUM_LETTERS; i++) {
    const u = unseen[i]!;
    pc[i] = u > 0 ? (p.pBase * u) / (u + aH) : 0;
  }
  let best = bestRewardCached(rack, p.minLen);
  const maxMiss = Math.min(p.maxMissing, A);
  if (maxMiss >= 1) {
    for (let i = 0; i < NUM_LETTERS; i++) {
      if (pc[i]! <= 0) continue;
      const v = bestRewardCached(rackPlus(rack, i), p.minLen) * pc[i]!;
      if (v > best) best = v;
    }
  }
  if (maxMiss >= 2) {
    const order = Array.from({ length: NUM_LETTERS }, (_, i) => i)
      .filter((i) => pc[i]! > 0)
      .sort((a, b) => pc[b]! - pc[a]! || a - b)
      .slice(0, p.pairTop);
    for (let x = 0; x < order.length; x++) {
      for (let y = x; y < order.length; y++) {
        const i = order[x]!;
        const j = order[y]!;
        if (i === j && unseen[i]! < 2) continue;
        const w = pc[i]! * pc[j]!;
        const r = rackPlus(rackPlus(rack, i), j);
        const v = bestRewardCached(r, p.minLen) * w;
        if (v > best) best = v;
      }
    }
  }
  return best;
}

/** gaucho linear bid x pacing multiplier (before floor, denial, shading and the balance cap). */
export function lionelBaseBid(delta: number, face: number, spend: number, p: LionelParams = LIONEL_DEFAULTS): number {
  const b = p.alpha * delta + (delta > 0 ? p.beta : p.beta * p.idleBeta) * face + p.gamma + p.pace * spend;
  return b * Math.exp(p.c0) * (Math.max(0.1, spend) / 3) ** p.c1;
}

export const createLionel: PolicyFactory = (_seed, opts) => {
  const p: LionelParams = { ...LIONEL_DEFAULTS, ...(opts as Partial<LionelParams> | undefined) };
  const name = 'clone:lionel';

  function denyTerm(view: MatchView, li: number): number {
    let m = 0;
    for (const o of view.opponents) {
      if (rackSize(o.knownHeld) < 3) continue;
      const gain = bestRewardCached(rackPlus(o.knownHeld, li), 2) - bestRewardCached(o.knownHeld, 2);
      if (gain > m) m = gain;
    }
    return p.denyW * m;
  }

  const policy: Policy = {
    name,
    onMatchStart() {},
    decide(view, auction) {
      const li = letterOf(auction);
      const A = auction.remainingAfter;
      const t = new Turn(view);
      const unseen = view.unseen;
      // ---- words
      if (A <= p.flushAt) t.dump();
      else {
        for (let k = 0; k < 4; k++) {
          const w = bestWord(t.rack, 2);
          if (!w) break;
          const needCash = t.balance < p.lowCash;
          if (w.reward < p.minPlayReward && !needCash) break;
          const potNow = lionelPot(t.rack, unseen, A, p);
          const potRest = lionelPot(rackMinusWord(t.rack, w.word), unseen, A, p);
          if (w.reward + potRest < p.holdKappa * potNow && !needCash) break;
          t.play(w.word);
        }
      }
      if (A <= 0) return t.decision(0);
      // ---- bid
      const balance = t.balance;
      const face = VALUE[li]!;
      let delta = Math.max(0, lionelPot(rackPlus(t.rack, li), unseen, A, p) - lionelPot(t.rack, unseen, A, p));
      const spend = balance / Math.max(1, A);
      if (A <= p.endN) {
        const dump = partition(rackPlus(t.rack, li)).score - partition(t.rack).score;
        if (A === 1) return t.decision(dump > 0 ? balance : 0);
        delta = Math.max(0, dump);
      }
      let b = lionelBaseBid(delta, face, spend, p);
      const r = auction.index + 1;
      const total = r + A;
      const behind = view.me.lettersWon < (p.letterTarget * r) / total - p.slack;
      if (behind && (delta > 0 || rackSize(t.rack) < 8)) {
        const q = Math.min(4, Math.floor(((r - 1) * 5) / total));
        b = Math.max(b, p.floorMult * lionelMarket(li, q) + 1);
      }
      b = Math.max(b, denyTerm(view, li));
      if (view.config.auctionType === 'FirstPrice') b *= p.shade;
      return t.decision(Math.min(b, balance));
    },
  };
  return policy;
};
