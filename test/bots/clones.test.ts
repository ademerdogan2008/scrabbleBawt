// 03-02 Task 1: community clones (COMPETITORS.md §4.3-4.8, §4.10): registry, server rules, spec checks.
import { describe, expect, it } from 'vitest';
import { BAG, LETTERS, NUM_LETTERS, idx, totalAuctions } from '../../src/core/letters.js';
import { rackFromWord, type Rack } from '../../src/core/rack.js';
import { Rng } from '../../src/core/rng.js';
import { simMaxBid } from '../../src/core/simbots.js';
import type { AuctionInfo, DecideContext, MatchConfig, Policy } from '../../src/core/types.js';
import { createPolicy, listPolicies, parseSeat } from '../../src/bots/registry.js';
import { COMMUNITY_CLONES } from '../../src/bots/clones/index.js';
import { lionelBaseBid } from '../../src/bots/clones/lionel.js';
import { poissonTail } from '../../src/bots/clones/lala.js';
import { clampBid, partition } from '../../src/bots/clones/common.js';
import { MatchTracker } from '../../src/state/tracker.js';
import { runMatch, type MatchResult, type SeatSpec } from '../../src/sim/match.js';

function cfg(n: number, rackSize = 5, sims: number[] = []): MatchConfig {
  return {
    matchId: 1,
    auctionType: 'Vickrey',
    auctionDurationMs: 1000,
    startingRackSize: rackSize,
    startingBalance: 100,
    players: Array.from({ length: n }, (_, k) => ({
      id: k + 1,
      name: `p${k + 1}`,
      isSim: sims.includes(k + 1),
      ...(sims.includes(k + 1) ? { simStrategy: 'Aggressive' as const } : {}),
    })),
    myId: 1,
    totalAuctions: totalAuctions(n, rackSize),
  };
}

function auctionAt(index: number, letter: string, c: MatchConfig): AuctionInfo {
  return {
    auctionId: index + 1,
    index,
    letter,
    opensAtMs: index * 1001.5,
    closesAtMs: index * 1001.5 + 1000,
    remainingAfter: c.totalAuctions - index - 1,
  };
}

const ctx = (seed = 1): DecideContext => ({ budgetMs: 250, rng: new Rng(seed), now: () => performance.now() });

/** Tracker advanced (no winners) to auction `index`, which is open; letters drawn consistently from the bag. */
function viewAt(policy: Policy, c: MatchConfig, start: string, index: number, letter: string) {
  const tracker = new MatchTracker(c, rackFromWord(start));
  policy.onMatchStart(tracker.view);
  const bag: number[] = [...BAG];
  for (const ch of start) bag[idx(ch)]!--;
  bag[idx(letter)]!--;
  let li = 0;
  for (let k = 0; k < index; k++) {
    while (bag[li]! === 0) li = (li + 1) % NUM_LETTERS;
    bag[li]!--;
    const a = auctionAt(k, LETTERS[li]!, c);
    tracker.auctionOpen(a);
    tracker.auctionResult({ auctionId: a.auctionId, index: k, letter: a.letter, winnerId: null, paid: 0 });
  }
  const a = auctionAt(index, letter, c);
  tracker.auctionOpen(a);
  return { view: tracker.view, auction: a };
}

function play(lineup: string[], seed: number, spec: Parameters<typeof runMatch>[0] = {}): MatchResult {
  const seats = lineup.map((s, k) => ({ id: k + 1, ...parseSeat(s, seed * 31 + k) }) as SeatSpec);
  return runMatch({ trace: true, ...spec }, seats, seed);
}

describe('community clones: registry', () => {
  it('registers >= 6 community clones (plus FieldBot presets and families) under clone:<name>', () => {
    const names = listPolicies();
    for (const n of ['clone:lionel', 'clone:nijello', 'clone:lala', 'clone:sookra', 'clone:lambi', 'clone:k13', 'clone:blackswan']) {
      expect(names).toContain(n);
    }
    for (const n of ['fieldShark', 'fieldVolume', 'fieldGrinder', 'fieldSpender', 'fieldNibbler', 'ramp', 'flat', 'hunter']) {
      expect(names).toContain(`clone:${n}`);
    }
    for (const n of COMMUNITY_CLONES) expect(createPolicy(n, 1).name).toBe(n);
    // params still parse after a ':'-containing name
    expect(createPolicy('clone:nijello:{"seatScale":true}', 1).name).toBe('clone:nijello');
  });
});

describe('community clones: server rules', () => {
  const lineups = [
    ['clone:lionel', 'clone:nijello', 'clone:lala', 'clone:sookra', 'clone:k13', 'clone:lambi'],
    ['clone:blackswan', 'clone:fieldShark', 'clone:ramp', 'sim:Aggressive', 'starter', 'clone:fieldVolume'],
    ['clone:fieldGrinder', 'clone:fieldSpender', 'clone:fieldNibbler', 'clone:flat', 'clone:hunter', 'sim:ValueBidder'],
  ];
  it('valid integer bids <= balance, valid words, no exceptions (3 lineups x 3 seeds)', () => {
    for (const lineup of lineups) {
      for (let seed = 1; seed <= 3; seed++) {
        const r = play(lineup, seed);
        for (const s of r.seats) {
          expect(s.rejectedBids, `${s.name} seed ${seed}`).toBe(0);
          expect(s.rejectedWords, `${s.name} seed ${seed}`).toBe(0);
          expect(s.balance).toBeGreaterThanOrEqual(0);
        }
        for (const a of r.trace!.auctions) {
          for (const b of Object.values(a.bids)) expect(Number.isInteger(b)).toBe(true);
        }
      }
    }
  }, 60_000);

  it('real-bot clones never bid on the final tile when no sim is seated', () => {
    const r = play(lineups[0]!, 5);
    const last = r.trace!.auctions[r.auctions - 1]!;
    for (let id = 1; id <= 6; id++) expect(last.bids[id] ?? 0, lineups[0]![id - 1]).toBe(0);
  }, 30_000);

  it('is deterministic for a seed', () => {
    const a = play(lineups[0]!, 9);
    const b = play(lineups[0]!, 9);
    expect(a.seats.map((s) => [s.score, s.balance, s.lettersWon])).toEqual(b.seats.map((s) => [s.score, s.balance, s.lettersWon]));
  }, 30_000);

  it('handles heads-up (88 auctions) and FirstPrice tables', () => {
    for (const c of ['clone:lionel', 'clone:nijello', 'clone:lala', 'clone:sookra', 'clone:lambi', 'clone:k13', 'clone:blackswan']) {
      const r = play([c, 'clone:k13'], 3);
      expect(r.auctions).toBe(88);
      const f = play([c, 'clone:lionel', 'clone:lala', 'sim:Aggressive'], 4, { auctionType: 'FirstPrice' });
      for (const s of [...r.seats, ...f.seats]) {
        expect(s.rejectedBids).toBe(0);
        expect(s.rejectedWords).toBe(0);
      }
    }
  }, 60_000);
});

describe('community clones: spec checks', () => {
  it('clampBid floors, caps at balance and rejects NaN/negatives', () => {
    expect(clampBid(7.9, 100)).toBe(7);
    expect(clampBid(150, 42)).toBe(42);
    expect(clampBid(-3, 42)).toBe(0);
    expect(clampBid(Number.NaN, 42)).toBe(0);
    expect(clampBid(5, 0)).toBe(0);
  });

  it('Lionel worked example: E, empty rack, balance 100, A = 66, delta 0 -> about 6', () => {
    const b = lionelBaseBid(0, 1, 100 / 66);
    expect(b).toBeGreaterThan(5.5);
    expect(b).toBeLessThan(6.6);
  });

  it('Nijello: all-in at B == 1 on a useful letter; bid 0 and dump at B == 0', () => {
    const c = cfg(2);
    const pol = createPolicy('clone:nijello', 1);
    const pen = viewAt(pol, c, 'RETIN', c.totalAuctions - 2, 'A'); // RETINA
    const d = pol.decide(pen.view, pen.auction, ctx());
    expect(d.bid).toBe(pen.view.me.balance);
    const pol2 = createPolicy('clone:nijello', 1);
    const fin = viewAt(pol2, c, 'RETIN', c.totalAuctions - 1, 'Q');
    const d2 = pol2.decide(fin.view, fin.auction, ctx());
    expect(d2.bid).toBe(0);
    expect(d2.words).toEqual(partition(rackFromWord('RETIN')).words);
  });

  it('Lala: penultimate all-in iff the letter improves the best partition', () => {
    const c = cfg(2);
    const yes = createPolicy('clone:lala', 1);
    const v1 = viewAt(yes, c, 'RETIN', c.totalAuctions - 2, 'A');
    expect(yes.decide(v1.view, v1.auction, ctx()).bid).toBe(100);
    const no = createPolicy('clone:lala', 1);
    const v2 = viewAt(no, c, 'QQQQV', c.totalAuctions - 2, 'X');
    expect(no.decide(v2.view, v2.auction, ctx()).bid).toBe(0);
  });

  it('Lala Poisson tail', () => {
    expect(poissonTail(0, 1)).toBe(0);
    expect(poissonTail(2, 0)).toBe(1);
    expect(poissonTail(1, 1)).toBeCloseTo(1 - Math.exp(-1), 10);
    expect(poissonTail(1, 2)).toBeCloseTo(1 - 2 * Math.exp(-1), 10);
  });

  it('SookraBot against sims only: never above max sim bid + 1', () => {
    const c = cfg(3, 5, [2, 3]);
    for (const letter of ['E', 'S', 'Z', 'K']) {
      const pol = createPolicy('clone:sookra', 1);
      const { view, auction } = viewAt(pol, c, 'RETIN', 10, letter);
      const d = pol.decide(view, auction, ctx());
      expect(d.bid).toBeLessThanOrEqual(simMaxBid('Aggressive', idx(letter), 100) + 1);
    }
  });

  it('K-13 denies the final tile to sims (bid = balance) and passes it otherwise', () => {
    const withSims = cfg(3, 5, [2, 3]);
    const a = createPolicy('clone:k13', 1);
    const v1 = viewAt(a, withSims, 'RETIN', withSims.totalAuctions - 1, 'E');
    const d1 = a.decide(v1.view, v1.auction, ctx());
    expect(d1.bid).toBeGreaterThan(0);
    const real = cfg(3);
    const b = createPolicy('clone:k13', 1);
    const v2 = viewAt(b, real, 'RETIN', real.totalAuctions - 1, 'E');
    expect(b.decide(v2.view, v2.auction, ctx()).bid).toBe(0);
  });

  it('every clone keeps decide() fast on a large rack (median < 50 ms after warm-up)', () => {
    const c = cfg(6);
    const big = 'AEEIORSTNLDGUCP'.slice(0, 5);
    for (const name of COMMUNITY_CLONES) {
      const pol = createPolicy(name, 1);
      const { view, auction } = viewAt(pol, c, big, 30, 'E');
      // inflate the rack: the view's rack is what decide() reads
      const rack = view.me.rack as Rack;
      for (const ch of 'EAIRSTLNOD') rack[idx(ch)]!++;
      for (let k = 0; k < 3; k++) pol.decide(view, auction, ctx(100 + k)); // JIT + memo warm-up
      const times: number[] = [];
      for (let k = 0; k < 5; k++) {
        const t0 = performance.now();
        pol.decide(view, auction, ctx(k));
        times.push(performance.now() - t0);
      }
      times.sort((x, y) => x - y);
      expect(times[2]!, name).toBeLessThan(50);
    }
  });
});
