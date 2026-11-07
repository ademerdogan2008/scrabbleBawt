// Lambi Lambiii clone (COMPETITORS.md §4.7). Word policy exact; bid from Karthik's class fits of
// its winning bids (Oct 25), as the spec prescribes. Re-implemented; nothing copied.
//
// Approximations:
//   * "adds nothing to the best packing" uses the fast packer (greedy + beam).
//   * Heads-up drain floor: "typical single-rival bid" = mean price the rival paid on its wins in
//     this match (NOW market price until it has won 3 letters).
//   * Denial term: +0.5 x the rival's immediate best-word gain on its publicly known tiles.
//   * The final dump plays the whole best partition at B == 0 (the spec plays words[0] per
//     auction; doing the rest at the final auction avoids stranding tiles).
import { IS_VOWEL, VALUE } from '../../core/letters.js';
import type { AuctionOutcome, MatchView, PlayerId, Policy, PolicyFactory } from '../../core/types.js';
import {
  NOW_PRICE,
  Turn,
  bestRewardCached,
  bestWord,
  gauss,
  letterOf,
  partition,
  partitionFast,
  progressOf,
  rackPlus,
  rackSize,
  realRivals,
} from './common.js';

export interface LambiParams {
  /** Multiplier on the fitted (winning-bid) levels. */
  kappa: number;
  uselessCut: number;
  drainShare: number;
  drainUntil: number;
  denyW: number;
}

export const LAMBI_DEFAULTS: Readonly<LambiParams> = Object.freeze({
  kappa: 1,
  uselessCut: 0.6,
  drainShare: 0.6,
  drainUntil: 12,
  denyW: 0.5,
});

/** Karthik's class fits of Lambi's winning bids (z = standard normal draw). */
export function lambiFit(li: number, progress: number, balance: number, z: number): number {
  const face = VALUE[li]!;
  const b = balance / 100;
  if (IS_VOWEL[li]) return 13.7 + 2.2 * progress - 2.3 * b + 4.2 * z;
  if (face === 1) return 12.9 + 4.0 * progress - 4.0 * b + 2.9 * z;
  if (face <= 4) return 5.5 + 5.22 * face + 2.4 * progress - 0.3 * b + 4.3 * z;
  return 10 + 3.6 * face + 2 * progress + 6 * z;
}

export const createLambi: PolicyFactory = (_seed, opts) => {
  const p: LambiParams = { ...LAMBI_DEFAULTS, ...(opts as Partial<LambiParams> | undefined) };
  const paid = new Map<PlayerId, [number, number]>();
  let myId = -1;
  const policy: Policy = {
    name: 'clone:lambi',
    onMatchStart(view) {
      myId = view.config.myId;
      paid.clear();
    },
    onAuctionClosed(_v: MatchView, o: AuctionOutcome) {
      if (o.winnerId === null || o.winnerId === myId) return;
      const cur = paid.get(o.winnerId) ?? [0, 0];
      paid.set(o.winnerId, [cur[0] + o.paid, cur[1] + 1]);
    },
    decide(view, auction, ctx) {
      const li = letterOf(auction);
      const B = auction.remainingAfter;
      const T = B + 1;
      const t = new Turn(view);
      const z = gauss(ctx.rng); // always drawn: keeps the stream aligned across branches
      // ---- words: one word of the best packing per auction when a trigger holds
      if (B === 0) {
        t.dump();
        return t.decision(0);
      }
      const best = bestWord(t.rack, 2);
      const tiles = rackSize(t.rack);
      const trigger =
        T <= 3 ||
        bestWord(t.rack, 7) !== undefined ||
        t.balance < 8 ||
        tiles >= 11 ||
        (T <= 12 && best !== undefined && best.word.length >= 5);
      if (trigger && best) {
        const pk = partition(t.rack);
        if (pk.words.length > 0) t.play(pk.words[0]!);
      }
      // ---- bid
      let bid = p.kappa * lambiFit(li, progressOf(view, auction), t.balance, z);
      if (rackSize(t.rack) >= 6 && partitionFast(rackPlus(t.rack, li)).score <= partitionFast(t.rack).score) {
        bid *= p.uselessCut;
      }
      const reals = realRivals(view);
      if (view.opponents.length === 1 && reals.length === 1) {
        const rival = reals[0]!;
        if (B >= p.drainUntil) {
          const m = paid.get(rival.info.id);
          const typical = m && m[1] >= 3 ? m[0] / m[1] : NOW_PRICE[li]!;
          bid = Math.max(bid, p.drainShare * typical);
        }
        const gain = bestRewardCached(rackPlus(rival.knownHeld, li), 2) - bestRewardCached(rival.knownHeld, 2);
        bid += p.denyW * Math.max(0, gain);
      }
      return t.decision(Math.max(0, bid));
    },
  };
  return policy;
};
