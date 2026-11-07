// Hoarder baseline: overbids (round(2.2 * value + 3), x1.6 in the last third of the match),
// never plays until the second-to-last auction (remainingAfter <= 1), then plays the exact best
// packing of the whole rack.
import { VALUE, idx } from '../../core/letters.js';
import type { Policy, PolicyFactory } from '../../core/types.js';
import { getEngine } from '../../engine/index.js';

export interface HoarderParams {
  bidMul: number;
  bidAdd: number;
  /** Multiplier applied to the bid in the last third of the auctions. */
  lateFactor: number;
  /** Start flushing when remainingAfter <= flushAt. */
  flushAt: number;
}

export const HOARDER_DEFAULTS: Readonly<HoarderParams> = Object.freeze({
  bidMul: 2.2,
  bidAdd: 3,
  lateFactor: 1.6,
  flushAt: 1,
});

export const createHoarder: PolicyFactory = (_seed, opts) => {
  const p: HoarderParams = { ...HOARDER_DEFAULTS, ...(opts as Partial<HoarderParams> | undefined) };
  const { packer } = getEngine();
  const policy: Policy = {
    name: 'hoarder',
    onMatchStart() {},
    decide(view, auction) {
      const value = VALUE[idx(auction.letter)] ?? 1;
      const late = auction.index >= (2 * view.config.totalAuctions) / 3;
      const raw = Math.round((p.bidMul * value + p.bidAdd) * (late ? p.lateFactor : 1));
      const bid = Math.max(0, Math.min(view.me.balance, raw));
      const words = auction.remainingAfter <= p.flushAt ? packer.packExact(view.me.rack).words : [];
      return { words, bid };
    },
  };
  return policy;
};
