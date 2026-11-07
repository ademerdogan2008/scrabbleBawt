// trick:shadow, the price-pusher / leader tax (PITFALLS M1; LetterSharkUltra "shadow"; K-13's
// price-driving term). It never wants letters: every auction it estimates the leading rival's
// value for the letter from that rival's observed prices (RivalBidModel: exact on our wins, lower
// bounds on its wins, NOW market prior) and bids 0.85x of it, so the leader pays close to its own
// valuation whenever it wins. Leader = highest score, ties: highest balance. Letters it wins by
// accident are dumped (best partition) at the last two auctions, or whenever the accidental hoard
// reaches cashAt tiles (keeps every decide() cheap).
import type { AuctionOutcome, MatchView, PlayerId, Policy, PolicyFactory } from '../../core/types.js';
import { Turn, letterOf, rackSize } from '../clones/common.js';
import { RivalBidModel } from './util.js';

export interface ShadowParams {
  share: number;
  dump: boolean;
  /** Safety valve: also dump when the accidental hoard reaches this many tiles. */
  cashAt: number;
}

export const SHADOW_DEFAULTS: Readonly<ShadowParams> = Object.freeze({ share: 0.85, dump: true, cashAt: 12 });

export const createShadow: PolicyFactory = (_seed, opts) => {
  const p: ShadowParams = { ...SHADOW_DEFAULTS, ...(opts as Partial<ShadowParams> | undefined) };
  const model = new RivalBidModel();
  let myId: PlayerId = -1;
  let rivals: PlayerId[] = [];
  const policy: Policy = {
    name: 'trick:shadow',
    onMatchStart(view) {
      myId = view.config.myId;
      rivals = view.opponents.map((o) => o.info.id);
      model.reset();
    },
    onAuctionClosed(_v: MatchView, o: AuctionOutcome) {
      model.observe(o, myId, rivals);
    },
    decide(view, auction) {
      const li = letterOf(auction);
      const t = new Turn(view);
      if (p.dump && (auction.remainingAfter <= 1 || rackSize(t.rack) >= p.cashAt)) t.dump();
      if (auction.remainingAfter === 0) return t.decision(0);
      let leader = view.opponents[0];
      for (const o of view.opponents) {
        if (!leader || o.score > leader.score || (o.score === leader.score && o.balance > leader.balance)) leader = o;
      }
      if (!leader) return t.decision(0);
      const est = Math.min(model.get(leader.info.id, li), leader.balance);
      return t.decision(p.share * est);
    },
  };
  return policy;
};
