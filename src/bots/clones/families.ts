// Karthik's fitted bidder families (COMPETITORS.md §4.10; fit on 1,568 live matches, all-real era):
//
//   family  bid formula                                             sd   words
//   Ramp    -2.5 + 2.8 face + 15 progress + 11 bal/100              6.2  none before progress .25,
//                                                                         then 7+ on sight; dump in last 3
//   Flat     7   + 2.75 face + 3 progress + 4.3 bal/100             4.7  5+ words on sight
//   Hunter   4.4 + 3.94 face + 7.1 progress + 3.2 bal/100           4.3  6+ words on sight
//
// Flat and Hunter dump the exact best partition in the last 2 auctions. Every family bids 0 on the
// final tile (its letter is unusable). Noise = sd x z from the seat stream.
import { VALUE } from '../../core/letters.js';
import type { Policy, PolicyFactory } from '../../core/types.js';
import { Turn, cashGreedy, gauss, letterOf, progressOf } from './common.js';

export interface FamilyParams {
  c0: number;
  cFace: number;
  cProgress: number;
  cBalance: number;
  sd: number;
  minLen: number;
  startProgress: number;
  dumpT: number;
}

export const FAMILIES: Readonly<Record<'ramp' | 'flat' | 'hunter', FamilyParams>> = Object.freeze({
  ramp: { c0: -2.5, cFace: 2.8, cProgress: 15, cBalance: 11, sd: 6.2, minLen: 7, startProgress: 0.25, dumpT: 3 },
  flat: { c0: 7, cFace: 2.75, cProgress: 3, cBalance: 4.3, sd: 4.7, minLen: 5, startProgress: 0, dumpT: 2 },
  hunter: { c0: 4.4, cFace: 3.94, cProgress: 7.1, cBalance: 3.2, sd: 4.3, minLen: 6, startProgress: 0, dumpT: 2 },
});

export function familyFactory(family: keyof typeof FAMILIES): PolicyFactory {
  const base = FAMILIES[family];
  return (_seed, opts) => {
    const p: FamilyParams = { ...base, ...(opts as Partial<FamilyParams> | undefined) };
    const policy: Policy = {
      name: `clone:${family}`,
      onMatchStart() {},
      decide(view, auction, ctx) {
        const li = letterOf(auction);
        const T = auction.remainingAfter + 1;
        const progress = progressOf(view, auction);
        const t = new Turn(view);
        const z = gauss(ctx.rng);
        if (T <= p.dumpT) t.dump();
        else if (progress >= p.startProgress) t.playAll(cashGreedy(t.rack, p.minLen, 4));
        if (T <= 1) return t.decision(0);
        const bid = p.c0 + p.cFace * VALUE[li]! + p.cProgress * progress + (p.cBalance * t.balance) / 100 + p.sd * z;
        return t.decision(bid);
      },
    };
    return policy;
  };
}
