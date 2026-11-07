import { describe, expect, it } from 'vitest';
import { VALUE, idx, totalAuctions } from '../../src/core/letters.js';
import { rackFromWord, rackToString } from '../../src/core/rack.js';
import { Rng } from '../../src/core/rng.js';
import type { AuctionInfo, DecideContext, MatchConfig, Policy } from '../../src/core/types.js';
import { getEngine } from '../../src/engine/index.js';
import { MatchTracker } from '../../src/state/tracker.js';
import { createPolicy, listPolicies, parseSeat } from '../../src/bots/registry.js';
import { runMatch, type SeatSpec } from '../../src/sim/match.js';

const engine = getEngine();

function cfg(rackSize: number, n = 2): MatchConfig {
  return {
    matchId: 1,
    auctionType: 'Vickrey',
    auctionDurationMs: 1000,
    startingRackSize: rackSize,
    startingBalance: 100,
    players: Array.from({ length: n }, (_, k) => ({ id: k + 1, name: `p${k + 1}`, isSim: false })),
    myId: 1,
    totalAuctions: totalAuctions(n, rackSize),
  };
}

function auction(index: number, letter: string, c: MatchConfig): AuctionInfo {
  return {
    auctionId: index + 1,
    index,
    letter,
    opensAtMs: index * 1001.5,
    closesAtMs: index * 1001.5 + 1000,
    remainingAfter: c.totalAuctions - index - 1,
  };
}

function ctx(seed = 1): DecideContext {
  return { budgetMs: 250, rng: new Rng(seed), now: () => performance.now() };
}

/** Drive a policy by hand: open -> decide -> apply words -> result. */
class Harness {
  readonly tracker: MatchTracker;
  constructor(
    readonly policy: Policy,
    readonly config: MatchConfig,
    start: string,
  ) {
    this.tracker = new MatchTracker(config, rackFromWord(start));
    policy.onMatchStart(this.tracker.view);
  }
  step(index: number, letter: string, winnerId: number | null, paid = 1): { words: string[]; bid: number } {
    const a = auction(index, letter, this.config);
    this.tracker.auctionOpen(a);
    const d = this.policy.decide(this.tracker.view, a, ctx(index + 1));
    for (const w of d.words) {
      this.tracker.wordPlay({ playerId: 1, word: w, reward: 0, auctionIndex: index });
    }
    const outcome = { auctionId: a.auctionId, index, letter, winnerId, paid: winnerId === null ? 0 : paid };
    this.tracker.auctionResult(outcome);
    this.policy.onAuctionClosed?.(this.tracker.view, outcome);
    return d;
  }
}

describe('starter (exact official bot-starter port)', () => {
  it('bids min(have==0 ? value+2 : max(1,value), max(0,balance)) from the pre-word state', () => {
    const c = cfg(5);
    const h = new Harness(createPolicy('starter', 1), c, 'QEAST');
    const view = h.tracker.view;
    for (const [k, letter] of [...'QZEKA'].entries()) {
      const a = auction(k, letter, c);
      h.tracker.auctionOpen(a);
      const d = h.policy.decide(view, a, ctx());
      const have = view.me.rack[idx(letter)]!;
      const value = VALUE[idx(letter)]!;
      const want = have === 0 ? value + 2 : Math.max(1, value);
      expect(d.bid).toBe(Math.min(want, Math.max(0, view.me.balance)));
      h.tracker.auctionResult({ auctionId: a.auctionId, index: k, letter, winnerId: null, paid: 0 });
    }
  });

  it('bids on every auction including the final one (trace check)', () => {
    const seats: SeatSpec[] = [
      { id: 1, ...parseSeat('starter', 1) } as SeatSpec,
      { id: 2, ...parseSeat('sim:Cheapskate') } as SeatSpec,
      { id: 3, ...parseSeat('sim:ValueBidder') } as SeatSpec,
    ];
    const r = runMatch({ trace: true }, seats, 11);
    const tr = r.trace!;
    const rack = rackFromWord(tr.startRacks[1]!);
    let bal = 100;
    const wordsAt = new Map<number, string[]>();
    for (const w of tr.words) if (w.seatId === 1) wordsAt.set(w.index, [...(wordsAt.get(w.index) ?? []), w.word]);
    for (const a of tr.auctions) {
      const li = idx(a.letter);
      const want = rack[li] === 0 ? VALUE[li]! + 2 : Math.max(1, VALUE[li]!);
      const expected = Math.min(want, Math.max(0, bal));
      expect(a.bids[1] ?? 0).toBe(expected);
      for (const w of wordsAt.get(a.index) ?? []) {
        for (const ch of w) rack[idx(ch)]!--;
        bal += tr.words.find((x) => x.seatId === 1 && x.index === a.index && x.word === w)!.reward;
      }
      if (a.winnerId === 1) {
        bal -= a.paid;
        rack[li]!++;
      }
    }
    expect(tr.auctions[r.auctions - 1]!.bids[1]).toBeGreaterThan(0);
    expect(rackToString(rack)).toBe(tr.finalRacks[1]);
  });

  it('plays exactly one word after the deal, then nothing until its next win, then resets per match', () => {
    const start = 'AAXX';
    const first = engine.index.findBestPlayable(rackFromWord(start), 2)!;
    const rest = rackFromWord(start);
    for (const ch of first) rest[idx(ch)]!--;
    expect(engine.index.findBestPlayable(rest, 2)).toBeDefined(); // precondition: second disjoint word

    const c = cfg(4);
    const p = createPolicy('starter', 1);
    const h = new Harness(p, c, start);
    expect(h.step(0, 'Q', 2).words).toEqual([first]); // after the deal
    expect(h.step(1, 'Q', 2).words).toEqual([]); // own word removal never re-triggers
    expect(h.step(2, 'Q', null).words).toEqual([]);
    expect(h.step(3, 'J', 1).words).toEqual([]); // wins this one...
    const after = h.step(4, 'Q', 2); // ...so the next decide tries again
    expect(after.words.length).toBe(1);
    expect(h.step(5, 'Q', 2).words).toEqual([]);

    const h2 = new Harness(p, c, start); // next match start re-arms the trigger
    expect(h2.step(0, 'Q', 2).words).toEqual([first]);
  });

  it('in full matches words only follow the deal or a starter win', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const seats: SeatSpec[] = [
        { id: 1, ...parseSeat('starter', seed) } as SeatSpec,
        { id: 2, ...parseSeat('sim:Aggressive') } as SeatSpec,
        { id: 3, ...parseSeat('sim:Cheapskate') } as SeatSpec,
      ];
      const r = runMatch({ trace: true }, seats, seed);
      const tr = r.trace!;
      const perIndex = new Map<number, number>();
      for (const w of tr.words) if (w.seatId === 1) perIndex.set(w.index, (perIndex.get(w.index) ?? 0) + 1);
      for (const [index, count] of perIndex) {
        expect(count).toBe(1);
        expect(index === 0 || tr.auctions[index - 1]!.winnerId === 1).toBe(true);
      }
      expect(r.seats[0]!.rejectedWords + r.seats[0]!.rejectedBids).toBe(0);
    }
  });
});

describe('greedy / hoarder / random', () => {
  it('greedy repeats bestSingleWord while one exists', () => {
    const c = cfg(6);
    const h = new Harness(createPolicy('greedy', 1), c, 'AAXXOQ');
    const a = auction(0, 'E', c);
    h.tracker.auctionOpen(a);
    const d = h.policy.decide(h.tracker.view, a, ctx());
    const rack = rackFromWord('AAXXOQ');
    const expected: string[] = [];
    for (;;) {
      const w = engine.index.bestSingleWord(rack, 2);
      if (!w) break;
      expected.push(w.word);
      for (const ch of w.word) rack[idx(ch)]!--;
    }
    expect(expected.length).toBeGreaterThanOrEqual(2);
    expect(d.words).toEqual(expected);
    expect(d.bid).toBe(Math.min(100, Math.round(1.5 * 1 + 2)));
  });

  it('hoarder plays nothing until remainingAfter <= 1, then packExact(rack).words', () => {
    const c = cfg(5);
    const h = new Harness(createPolicy('hoarder', 1), c, 'QUIZE');
    const early = auction(0, 'S', c);
    h.tracker.auctionOpen(early);
    const d0 = h.policy.decide(h.tracker.view, early, ctx());
    expect(d0.words).toEqual([]);
    expect(d0.bid).toBe(Math.round(2.2 * 1 + 3));
    const late: AuctionInfo = { ...auction(c.totalAuctions - 2, 'S', c), auctionId: 99 };
    expect(late.remainingAfter).toBe(1);
    const d1 = h.policy.decide(h.tracker.view, late, ctx());
    expect(d1.words).toEqual(engine.packer.packExact(rackFromWord('QUIZE')).words);
    expect(d1.words.length).toBeGreaterThan(0);
    expect(d1.bid).toBe(Math.min(100, Math.round((2.2 * 1 + 3) * 1.6)));
  });

  it('random bids uniformly within [0, min(balance, 3v+5)] using ctx.rng', () => {
    const c = cfg(5);
    const h = new Harness(createPolicy('random', 1), c, 'AEIRT');
    const bids = new Set<number>();
    for (let k = 0; k < 200; k++) {
      const a = auction(0, 'Z', c);
      const d = h.policy.decide(h.tracker.view, a, ctx(k));
      expect(d.bid).toBeGreaterThanOrEqual(0);
      expect(d.bid).toBeLessThanOrEqual(35);
      expect(Number.isInteger(d.bid)).toBe(true);
      for (const w of d.words) expect(engine.dict.isValid(w)).toBe(true);
      bids.add(d.bid);
    }
    expect(bids.size).toBeGreaterThan(20);
  });
});

describe('registry', () => {
  it('resolves every listed name and parses sim / param specs', () => {
    const names = listPolicies();
    for (const n of ['starter', 'greedy', 'hoarder', 'random']) expect(names).toContain(n);
    for (const n of names) {
      const p = createPolicy(n, 3);
      expect(typeof p.decide).toBe('function');
      expect(p.name.length).toBeGreaterThan(0);
    }
    const sim = parseSeat('sim:Aggressive');
    expect(sim).toMatchObject({ kind: 'sim', simStrategy: 'Aggressive' });
    expect(parseSeat('sim:cheapskate')).toMatchObject({ kind: 'sim', simStrategy: 'Cheapskate' });
    const pol = parseSeat('greedy');
    expect(pol.kind).toBe('policy');
    expect(createPolicy('hoarder:{"lateFactor":2}', 1).name).toBe('hoarder');
    expect(() => createPolicy('nope', 1)).toThrow(/unknown policy/i);
    expect(() => parseSeat('sim:Nope')).toThrow(/sim strategy/i);
    expect(parseSeat('oracle:greedy')).toMatchObject({ kind: 'policy', oracle: true });
  });
});

describe('server-rule compliance', () => {
  it('every baseline submits only integer bids <= balance and valid words over 50 matches', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const specs = ['starter', 'greedy', 'hoarder', 'random', 'sim:Aggressive', 'sim:ValueBidder'];
      const seats = specs.map((s, k) => ({ id: k + 1, ...parseSeat(s, seed * 10 + k) }) as SeatSpec);
      const r = runMatch({}, seats, seed);
      for (const s of r.seats) {
        expect(s.rejectedBids, `${s.name} seed ${seed}`).toBe(0);
        expect(s.rejectedWords, `${s.name} seed ${seed}`).toBe(0);
        expect(s.balance).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
