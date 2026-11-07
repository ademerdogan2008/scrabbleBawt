// trick:endgameDumper (PITFALLS M4; Bron's last-5 escalation, HISTORICAL §E3). Thrifty until the
// last `window` auctions: bids thrift x NOW market only on letters that raise its pack value,
// cashes 7+ words on sight. In the window (B <= window, final tile excluded) it spends everything:
// bid = ceil(spread x balance / B), i.e. the whole balance at B == 1. Dumps at T <= 2; final tile 0.
import type { Policy, PolicyFactory } from '../../core/types.js';
import { NOW_PRICE, Turn, letterOf, rackPlus } from '../clones/common.js';
import { sookraPackValue } from '../clones/sookra.js';
import { standardWords } from './util.js';

export interface EndgameDumperParams {
  window: number;
  thrift: number;
  spread: number;
}

export const ENDGAME_DUMPER_DEFAULTS: Readonly<EndgameDumperParams> = Object.freeze({ window: 10, thrift: 0.5, spread: 2 });

export const createEndgameDumper: PolicyFactory = (_seed, opts) => {
  const p: EndgameDumperParams = { ...ENDGAME_DUMPER_DEFAULTS, ...(opts as Partial<EndgameDumperParams> | undefined) };
  const policy: Policy = {
    name: 'trick:endgameDumper',
    onMatchStart() {},
    decide(view, auction) {
      const li = letterOf(auction);
      const B = auction.remainingAfter;
      const t = new Turn(view);
      standardWords(t, auction);
      if (B === 0) return t.decision(0);
      if (B <= p.window) return t.decision(Math.ceil((p.spread * t.balance) / B));
      const gain = sookraPackValue(rackPlus(t.rack, li), 0.35) - sookraPackValue(t.rack, 0.35);
      return t.decision(gain > 0 ? p.thrift * NOW_PRICE[li]! : 0);
    },
  };
  return policy;
};
