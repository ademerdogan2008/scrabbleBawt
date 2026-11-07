// trick:oracleDenier, a deal-aware denial bidder (PITFALLS M5 and C1; COMPETITORS §7 "starting-rack
// reconstruction"). It models RNG-exploiting rivals: seated as `oracle:trick:oracleDenier`, the
// simulator hands it every player's TRUE rack before each decide() (Policy.onOracle, simulator-only
// threat modelling; our own bot never implements onOracle). Without oracle racks it falls back to
// the public lower bound (knownHeld).
//
// Each auction: leader = the rival with the highest score (ties: more tiles). If the open letter
// completes a 7+ letter word for the leader (best 7+ reward with the letter > without), it bids
// high: min(balance, max(floor, ceil(gainShare x gain))). Otherwise it bids a modest truthful value
// (0.8 x util.truthfulBid). Words: 7+ on sight, dump at T <= 2; final tile 0.
import type { Rack } from '../../core/rack.js';
import type { PlayerId, Policy, PolicyFactory } from '../../core/types.js';
import { Turn, bestRewardCached, letterOf, rackPlus, rackSize } from '../clones/common.js';
import { standardWords, truthfulBid } from './util.js';

export interface OracleDenierParams {
  floor: number;
  gainShare: number;
  ownShare: number;
}

export const ORACLE_DENIER_DEFAULTS: Readonly<OracleDenierParams> = Object.freeze({ floor: 20, gainShare: 0.8, ownShare: 0.8 });

export const createOracleDenier: PolicyFactory = (_seed, opts) => {
  const p: OracleDenierParams = { ...ORACLE_DENIER_DEFAULTS, ...(opts as Partial<OracleDenierParams> | undefined) };
  let racks: ReadonlyMap<PlayerId, Rack> | undefined;
  let denials = 0;
  const policy: Policy & { readonly denials: number; readonly sawOracle: boolean } = {
    name: 'trick:oracleDenier',
    get denials() {
      return denials;
    },
    get sawOracle() {
      return racks !== undefined;
    },
    onMatchStart() {
      racks = undefined;
      denials = 0;
    },
    onOracle(trueRacks) {
      racks = trueRacks;
    },
    decide(view, auction, ctx) {
      const li = letterOf(auction);
      const t = new Turn(view);
      standardWords(t, auction);
      if (auction.remainingAfter === 0) return t.decision(0);
      let leader = view.opponents[0];
      const rackOf = (id: PlayerId, fallback: Rack): Rack => racks?.get(id) ?? fallback;
      for (const o of view.opponents) {
        if (!leader) leader = o;
        const size = rackSize(rackOf(o.info.id, o.knownHeld));
        const lsize = rackSize(rackOf(leader.info.id, leader.knownHeld));
        if (o.score > leader.score || (o.score === leader.score && size > lsize)) leader = o;
      }
      if (leader) {
        const r = rackOf(leader.info.id, leader.knownHeld);
        const gain = bestRewardCached(rackPlus(r, li), 7) - bestRewardCached(r, 7);
        if (gain > 0) {
          denials++;
          return t.decision(Math.max(p.floor, Math.ceil(p.gainShare * gain)));
        }
      }
      return t.decision(p.ownShare * truthfulBid(view, auction, t, ctx.rng));
    },
  };
  return policy;
};
