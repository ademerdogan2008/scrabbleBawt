// trick:baiter, "greedybot bait": find the greediest spender (most coins paid so far), push its
// Vickrey price to just under its estimated bid while it is rich, then let go and use the coins
// it kept to buy letters cheaply once the target is drained.
//   phase 1 (index < switchAt·T, target balance > drainedAt): bid share·est(target), adapting
//            share up after each push the target pays (+step) and down after an accidental win
//            (-2·step, the overshoot cost us coins);
//   phase 2: truthful-ish buyer (truthfulBid) with standard word cashing.
import type { AuctionOutcome, MatchView, PlayerId, Policy, PolicyFactory } from '../../core/types.js';
import { Rng } from '../../core/rng.js';
import { Turn, letterOf } from '../clones/common.js';
import { RivalBidModel, standardWords, truthfulBid } from './util.js';

export interface BaiterParams {
  share: number;
  step: number;
  shareLo: number;
  shareHi: number;
  switchAt: number;
  drainedAt: number;
}

export const BAITER_DEFAULTS: Readonly<BaiterParams> = Object.freeze({
  share: 0.8,
  step: 0.03,
  shareLo: 0.5,
  shareHi: 0.97,
  switchAt: 0.6,
  drainedAt: 15,
});

export const createBaiter: PolicyFactory = (seed, opts) => {
  const p: BaiterParams = { ...BAITER_DEFAULTS, ...(opts as Partial<BaiterParams> | undefined) };
  const rng = new Rng(seed ^ 0xba17);
  const model = new RivalBidModel();
  const paid = new Map<PlayerId, number>();
  let myId: PlayerId = -1;
  let rivals: PlayerId[] = [];
  let share = p.share;
  let lastTarget: PlayerId | null = null;
  const policy: Policy = {
    name: 'trick:baiter',
    onMatchStart(view) {
      myId = view.config.myId;
      rivals = view.opponents.map((o) => o.info.id);
      model.reset();
      paid.clear();
      share = p.share;
      lastTarget = null;
    },
    onAuctionClosed(_v: MatchView, o: AuctionOutcome) {
      model.observe(o, myId, rivals);
      if (o.winnerId !== null) paid.set(o.winnerId, (paid.get(o.winnerId) ?? 0) + o.paid);
      if (lastTarget !== null) {
        if (o.winnerId === lastTarget) share = Math.min(p.shareHi, share + p.step);
        else if (o.winnerId === myId) share = Math.max(p.shareLo, share - 2 * p.step);
      }
    },
    decide(view, auction) {
      const li = letterOf(auction);
      const t = new Turn(view);
      standardWords(t, auction);
      lastTarget = null;
      if (auction.remainingAfter === 0) return t.decision(0);
      const T = view.config.totalAuctions;
      let target = null as (typeof view.opponents)[number] | null;
      for (const o of view.opponents) if (!target || (paid.get(o.info.id) ?? 0) > (paid.get(target.info.id) ?? 0)) target = o;
      const pushing = auction.index < p.switchAt * T && target !== null && target.balance > p.drainedAt;
      if (pushing && target) {
        lastTarget = target.info.id;
        const est = Math.min(model.get(target.info.id, li), target.balance);
        return t.decision(Math.min(t.balance, share * est));
      }
      return t.decision(truthfulBid(view, auction, t, rng));
    },
  };
  return policy;
};
