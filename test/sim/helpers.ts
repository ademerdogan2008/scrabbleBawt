// Shared helpers for simulator tests: scripted policies and seat builders.
import { VALUE, idx } from '../../src/core/letters.js';
import type { AuctionInfo, Decision, MatchView, Policy, SimStrategy } from '../../src/core/types.js';
import { getEngine } from '../../src/engine/index.js';
import type { SeatSpec } from '../../src/sim/match.js';

export type DecideFn = (view: MatchView, auction: AuctionInfo) => Decision;

/** Policy whose decide() is a plain function (no state). */
export function scripted(name: string, fn: DecideFn): Policy {
  return { name, onMatchStart() {}, decide: (v, a) => fn(v, a) };
}

export const noBid: DecideFn = () => ({ words: [], bid: 0 });
export const constBid =
  (amount: number): DecideFn =>
  (v) => ({ words: [], bid: Math.min(amount, v.me.balance) });

/** Plays every best single word greedily, bids face value + 1. */
export const simpleGreedy: DecideFn = (v, a) => {
  const { index } = getEngine();
  const rack = new Uint8Array(v.me.rack);
  const words: string[] = [];
  for (;;) {
    const w = index.bestSingleWord(rack, 2);
    if (!w) break;
    words.push(w.word);
    for (const c of w.word) rack[c.charCodeAt(0) - 65]!--;
  }
  const value = VALUE[idx(a.letter)]!;
  return { words, bid: Math.min(v.me.balance, value + 1) };
};

export function policySeat(id: number, policy: Policy, oracle = false): SeatSpec {
  return { id, name: policy.name, kind: 'policy', policy, oracle };
}

export function simSeat(id: number, simStrategy: SimStrategy): SeatSpec {
  return { id, name: `${simStrategy}-sim#${id}`, kind: 'sim', simStrategy };
}

/** Module lobby sim mix (bot ids 1..6 strategies). */
export const LOBBY_SIMS: SimStrategy[] = ['Cheapskate', 'ValueBidder', 'Aggressive', 'ValueBidder', 'Aggressive', 'Cheapskate'];

export function sixSims(firstId = 1): SeatSpec[] {
  return LOBBY_SIMS.map((s, k) => simSeat(firstId + k, s));
}
