// trick:spite, the heads-up Vickrey spite / drain bidder (SookraBot duel spite, Lambi/Karthik drain
// floors; COMPETITORS §4.6, §5 item 10, §7 "drain / price floors"). On letters it does not need it
// bids just under the opponent's predicted bid (RivalBidModel: exact on its own wins, lower bounds
// on the opponent's wins), so the opponent pays close to its own valuation; on letters it needs
// it bids its truthful value (util.truthfulBid), at least the spite bid. The opponent is the only
// rival heads-up, else the leading rival. "Needs" = SookraBot pack value gain > needMin.
// Words: 7+ on sight, dump at T <= 2; final tile 0.
import type { AuctionOutcome, MatchView, PlayerId, Policy, PolicyFactory } from '../../core/types.js';
import { Turn, letterOf, rackPlus } from '../clones/common.js';
import { sookraPackValue } from '../clones/sookra.js';
import { RivalBidModel, standardWords, truthfulBid } from './util.js';

export interface SpiteParams {
  under: number;
  needMin: number;
}

export const SPITE_DEFAULTS: Readonly<SpiteParams> = Object.freeze({ under: 1, needMin: 2 });

export const createSpite: PolicyFactory = (_seed, opts) => {
  const p: SpiteParams = { ...SPITE_DEFAULTS, ...(opts as Partial<SpiteParams> | undefined) };
  const model = new RivalBidModel();
  let myId: PlayerId = -1;
  let rivals: PlayerId[] = [];
  const policy: Policy = {
    name: 'trick:spite',
    onMatchStart(view) {
      myId = view.config.myId;
      rivals = view.opponents.map((o) => o.info.id);
      model.reset();
    },
    onAuctionClosed(_v: MatchView, o: AuctionOutcome) {
      model.observe(o, myId, rivals);
    },
    decide(view, auction, ctx) {
      const li = letterOf(auction);
      const t = new Turn(view);
      standardWords(t, auction);
      if (auction.remainingAfter === 0) return t.decision(0);
      let opp = view.opponents[0];
      for (const o of view.opponents) if (!opp || o.score > opp.score) opp = o;
      const spiteBid = opp ? Math.min(opp.balance, model.get(opp.info.id, li)) - p.under : 0;
      const need = sookraPackValue(rackPlus(t.rack, li), 0.35) - sookraPackValue(t.rack, 0.35);
      if (need > p.needMin) return t.decision(Math.max(spiteBid, truthfulBid(view, auction, t, ctx.rng)));
      return t.decision(spiteBid);
    },
  };
  return policy;
};
