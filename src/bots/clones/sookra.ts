// SookraBot clone (COMPETITORS.md §4.6, finals-patch branch, core only). Re-implemented from the
// spec (MIT fork upstream, but nothing copied).
//
// Approximations:
//   * The look-ahead x0.75 term is ignored (as the spec suggests for a clone).
//   * "Predicted rival bid" (duel spite) = max(NOW market price, 1.2 x mean price the rival paid
//     on its wins of the same face value), from public auction results only.
//   * "Every rival can bid <= 2": sims by their exact maximum, real bots by their balance.
//   * FirstPrice: bid = min(full bid, 20% quantile of the last <= 40 rival prices) with >= 5
//     observations, else 0.4 x the full bid.
import { NUM_LETTERS, VALUE, idx } from '../../core/letters.js';
import type { Rack } from '../../core/rack.js';
import type { AuctionOutcome, MatchView, PlayerId, Policy, PolicyFactory } from '../../core/types.js';
import {
  NOW_PRICE,
  Turn,
  clamp,
  letterOf,
  maxRivalCapacity,
  maxSimBid,
  partitionFast,
  rackMinusWord,
  rackPlus,
  realRivals,
  richestRival,
  simRivals,
  topWords,
} from './common.js';

const LEAVE_STR =
  'A6.38 B6.75 C7.17 D5.79 E6.87 F7.39 G5.55 H8.61 I5.53 J8.8 K9.64 L5.41 M7.66 N5.06 O6.32 P7.11 Q4.61 R5.2 S6.8 T4.92 U5.52 V4.82 W6.57 X10.54 Y8.93 Z11.91';
export const SOOKRA_LEAVE_W7: readonly number[] = (() => {
  const out = new Array<number>(NUM_LETTERS).fill(0);
  for (const tok of LEAVE_STR.split(' ')) out[idx(tok[0]!)] = Number(tok.slice(1));
  return Object.freeze(out);
})();

export interface SookraParams {
  leaveW: number;
  kappa0: number;
  simOnlyKappa: number;
  earlyCut: number;
  earlyIndex: number;
  lateBoost: number;
  lateT: number;
  dumpT: number;
  liquidity: number;
  brokeMax: number;
}

export const SOOKRA_DEFAULTS: Readonly<SookraParams> = Object.freeze({
  leaveW: 0.35,
  kappa0: 3.8,
  simOnlyKappa: 20,
  earlyCut: 0.7,
  earlyIndex: 28,
  lateBoost: 2,
  lateT: 8,
  dumpT: 3,
  liquidity: 15,
  brokeMax: 2,
});

/** Greedy packing total + leaveW x Σ LEAVE_W7(leftover). */
export function sookraPackValue(r: Rack, leaveW: number): number {
  const pk = partitionFast(r);
  const left = new Uint8Array(r);
  for (const w of pk.words) for (let k = 0; k < w.length; k++) left[w.charCodeAt(k) - 65]!--;
  let lv = 0;
  for (let i = 0; i < NUM_LETTERS; i++) lv += left[i]! * SOOKRA_LEAVE_W7[i]!;
  return pk.score + leaveW * lv;
}

export const createSookra: PolicyFactory = (_seed, opts) => {
  const p: SookraParams = { ...SOOKRA_DEFAULTS, ...(opts as Partial<SookraParams> | undefined) };
  // rival id -> face -> [sum paid, n] on its wins
  const paidByRival = new Map<PlayerId, Map<number, [number, number]>>();
  let myId = -1;
  const recentRivalPrices: number[] = [];

  const predict = (rival: PlayerId, li: number): number => {
    const m = paidByRival.get(rival)?.get(VALUE[li]!);
    const est = m && m[1] > 0 ? (1.2 * m[0]) / m[1] : 0;
    return Math.max(NOW_PRICE[li]!, est);
  };

  const policy: Policy = {
    name: 'clone:sookra',
    onMatchStart(view) {
      myId = view.config.myId;
      paidByRival.clear();
      recentRivalPrices.length = 0;
    },
    onAuctionClosed(_v: MatchView, o: AuctionOutcome) {
      if (o.winnerId === null || o.winnerId === myId) return;
      let m = paidByRival.get(o.winnerId);
      if (!m) paidByRival.set(o.winnerId, (m = new Map()));
      const face = VALUE[idx(o.letter)]!;
      const cur = m.get(face) ?? [0, 0];
      m.set(face, [cur[0] + o.paid, cur[1] + 1]);
      recentRivalPrices.push(o.paid);
      if (recentRivalPrices.length > 40) recentRivalPrices.shift();
    },
    decide(view, auction) {
      const li = letterOf(auction);
      const B = auction.remainingAfter;
      const T = B + 1;
      const t = new Turn(view);
      // ---- words: hold; dump in the last dumpT auctions; liquidity cash when poor
      if (T <= p.dumpT) t.dump();
      else if (t.balance < p.liquidity) {
        const cands = topWords(t.rack, 2, 12);
        const long = cands.filter((w) => w.word.length >= 5);
        const pool = long.length > 0 ? long : cands;
        let best = -Infinity;
        let pick: string | undefined;
        for (const w of pool) {
          const v = sookraPackValue(rackMinusWord(t.rack, w.word), p.leaveW);
          if (v > best) {
            best = v;
            pick = w.word;
          }
        }
        if (pick) t.play(pick);
      }
      if (B === 0 || t.balance <= 0) return t.decision(0);
      // ---- bid
      const delta = sookraPackValue(rackPlus(t.rack, li), p.leaveW) - sookraPackValue(t.rack, p.leaveW);
      const reals = realRivals(view);
      const sims = simRivals(view);
      if (B === 1 && sims.length === 0) return t.decision(delta > 0 ? Math.min(t.balance, richestRival(view) + 1) : 0);
      if (delta <= 0) return t.decision(0);
      if (reals.length === 0) return t.decision(Math.min(p.simOnlyKappa * delta, maxSimBid(view, li) + 1));
      const cap = maxRivalCapacity(view, li);
      if (cap <= p.brokeMax) return t.decision(cap + 1);
      const duel = view.opponents.length === 1;
      const r = t.balance / T / (100 / 68);
      let kappa = p.kappa0 * clamp(Math.sqrt(r), duel ? 0.75 : 0.5, 3);
      if (auction.index < p.earlyIndex && reals.length >= 2) kappa *= p.earlyCut;
      if (T < p.lateT) kappa *= p.lateBoost;
      let bid = kappa * delta;
      if (view.config.auctionType === 'FirstPrice') {
        if (recentRivalPrices.length >= 5) {
          const sorted = [...recentRivalPrices].sort((a, b) => a - b);
          bid = Math.min(bid, sorted[Math.floor(0.2 * (sorted.length - 1))]!);
        } else bid *= 0.4;
      } else if (duel) {
        const pred = predict(view.opponents[0]!.info.id, li);
        if (pred > bid && bid > 0) {
          const taper = T <= 15 ? T / 15 : 1;
          bid = Math.min(bid + 0.5 * (pred - bid) * taper, 2 * bid);
        }
      }
      return t.decision(bid);
    },
  };
  return policy;
};
