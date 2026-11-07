// Shared helpers for the trick zoo (03-02 Task 3; PITFALLS.md "Catalog of opponent tricks",
// COMPETITORS.md §4.10 / §7). Built on the clone helpers (src/bots/clones/common.ts).
import { VALUE, idx } from '../../core/letters.js';
import type { Rng } from '../../core/rng.js';
import type { AuctionInfo, AuctionOutcome, MatchView, PlayerId, Policy } from '../../core/types.js';
import { mcLetterValue } from '../clones/blackswan.js';
import { NOW_PRICE, type Turn, cashGreedy } from '../clones/common.js';
import { lionelBaseBid } from '../clones/lionel.js';

/** Same policy under another registry name. */
export function renamed(policy: Policy, name: string): Policy {
  return {
    name,
    onMatchStart: (v) => policy.onMatchStart(v),
    decide: (v, a, c) => policy.decide(v, a, c),
    ...(policy.onAuctionClosed ? { onAuctionClosed: (v: MatchView, o: AuctionOutcome) => policy.onAuctionClosed!(v, o) } : {}),
    ...(policy.onMatchEnd ? { onMatchEnd: (v: MatchView) => policy.onMatchEnd!(v) } : {}),
    ...(policy.onOracle ? { onOracle: policy.onOracle.bind(policy) } : {}),
  };
}

/** Standard trick word policy: cash 7+ words on sight; dump the exact best partition at T <= 2. */
export function standardWords(t: Turn, auction: AuctionInfo, minLen = 7): void {
  if (auction.remainingAfter + 1 <= 2) t.dump();
  else t.playAll(cashGreedy(t.rack, minLen, 4));
}

/**
 * "Truthful" coin value of the open letter: gaucho's linear bid (Lionel, COMPETITORS §4.3) on a
 * Monte Carlo marginal value (4 sampled futures). Shared by jitter / sniper / denier / spite.
 */
export function truthfulBid(view: MatchView, auction: AuctionInfo, t: Turn, rng: Rng): number {
  const li = idx(auction.letter);
  const B = auction.remainingAfter;
  const delta = mcLetterValue(t.rack, li, view.unseen, Math.min(5, Math.floor(B / 4)), 4, rng);
  return lionelBaseBid(delta, VALUE[li]!, t.balance / Math.max(1, B));
}

/**
 * Per-rival bid estimate per face value, from public auction results:
 *   - we won: paid = max of the other bids, an exact draw of the top rival bid (heads-up: exact)
 *   - the rival won: its bid >= paid (a lower bound)
 * est starts at 1.2 x the NOW market price of a letter of that face value.
 */
export class RivalBidModel {
  private est = new Map<PlayerId, Map<number, number>>();
  constructor(
    private readonly alpha = 0.3,
    private readonly prior = 1.2,
  ) {}

  reset(): void {
    this.est.clear();
  }

  get(rival: PlayerId, li: number): number {
    return this.est.get(rival)?.get(VALUE[li]!) ?? this.prior * NOW_PRICE[li]!;
  }

  private set(rival: PlayerId, li: number, v: number): void {
    let m = this.est.get(rival);
    if (!m) this.est.set(rival, (m = new Map()));
    m.set(VALUE[li]!, v);
  }

  observe(o: AuctionOutcome, myId: PlayerId, rivalIds: readonly PlayerId[]): void {
    if (o.winnerId === null) return;
    const li = idx(o.letter);
    if (o.winnerId === myId) {
      // exact draw of the strongest rival's bid: attribute it to every tracked rival (heads-up exact)
      for (const r of rivalIds) this.set(r, li, (1 - this.alpha) * this.get(r, li) + this.alpha * o.paid);
      return;
    }
    const cur = this.get(o.winnerId, li);
    const lb = o.paid + 1;
    this.set(o.winnerId, li, cur < lb ? lb : (1 - this.alpha) * cur + this.alpha * Math.max(lb, o.paid * 1.25));
  }
}
