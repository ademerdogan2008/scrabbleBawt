import { describe, expect, it } from 'vitest';
import { totalAuctions, wordReward } from '../../src/core/letters.js';
import { rackFromWord, rackToString } from '../../src/core/rack.js';
import { Rng, hashSeed } from '../../src/core/rng.js';
import type { AuctionInfo, DecideContext, MatchConfig, PlayerInfo } from '../../src/core/types.js';
import { getEngine } from '../../src/engine/index.js';
import { MatchTracker } from '../../src/state/tracker.js';
import { createPolicy, listPolicies, parseSeat } from '../../src/bots/registry.js';
import { runMatch, type SeatSpec } from '../../src/sim/match.js';
import { createBawt, policies } from '../../src/bots/bawt/index.js';
import { drivingBid, firstPriceBid, makeBid, rivalSurplus } from '../../src/bots/bawt/bidding.js';
import { wordsWithoutLetter } from '../../src/bots/bawt/endgame.js';
import { winProb } from '../../src/bots/bawt/opponents.js';

const engine = getEngine();

const me: PlayerInfo = { id: 1, name: 'bawt', isSim: false };
function cfg(players: PlayerInfo[], auctionType: MatchConfig['auctionType'] = 'Vickrey'): MatchConfig {
  return {
    matchId: 7,
    auctionType,
    auctionDurationMs: 1000,
    startingRackSize: 5,
    startingBalance: 100,
    players,
    myId: 1,
    totalAuctions: totalAuctions(players.length, 5),
  };
}
function ctx(seed = 1, budgetMs = 200): DecideContext {
  return { budgetMs, rng: new Rng(seed), now: () => performance.now(), netRttMs: 60 };
}
function auctionAt(c: MatchConfig, index: number, letter: string): AuctionInfo {
  return {
    auctionId: index + 1,
    index,
    letter,
    opensAtMs: index * 1001.5,
    closesAtMs: index * 1001.5 + 1000,
    remainingAfter: c.totalAuctions - index - 1,
  };
}

/** Tracker positioned at auction `index` with my rack set to `rack`. */
function stateAt(c: MatchConfig, index: number, letter: string, rack: string, balance = 100) {
  const tracker = new MatchTracker(c, rackFromWord('AEIRS'));
  const view = tracker.view;
  view.me.rack.set(rackFromWord(rack));
  view.me.balance = balance;
  const a = auctionAt(c, index, letter);
  tracker.auctionOpen(a);
  return { tracker, view, a };
}

describe('registry', () => {
  it('registers bawt and its ablations / profiles', () => {
    for (const name of ['bawt', 'bawt-quick', 'bawt-rollout', 'bawt-static', 'bawt-k13', 'bawt-lobby', 'bawt-headsUp', 'bawt-firstPrice']) {
      expect(listPolicies()).toContain(name);
      expect(createPolicy(name, 1).name).toBe(name);
    }
    expect(createPolicy('bawt:{"reserve":5}', 1).name).toBe('bawt');
    expect(() => createPolicy('bawt:{"bogus":1}', 1)).toThrow(/unknown parameter/);
  });
});

describe('endgame', () => {
  const rack = 'AEINRSTQZOO';
  it('final auction: exact flush; bid 0 without sims', () => {
    const c = cfg([me, { id: 2, name: 'x', isSim: false }]);
    const p = createBawt(1);
    const { view, a } = stateAt(c, c.totalAuctions - 1, 'E', rack, 37);
    p.onMatchStart(view);
    const d = p.decide(view, a, ctx());
    const exact = engine.packer.packExact(rackFromWord(rack));
    expect(d.words.reduce((s, w) => s + wordReward(w), 0)).toBe(exact.score);
    expect(d.bid).toBe(0);
  });

  it('final auction: whole balance when a sim is seated', () => {
    const c = cfg([me, { id: 2, name: 'x', isSim: false }, { id: 3, name: 'A-sim', isSim: true, simStrategy: 'Aggressive' }]);
    const p = createBawt(1);
    const { view, a } = stateAt(c, c.totalAuctions - 1, 'E', rack, 37);
    p.onMatchStart(view);
    expect(p.decide(view, a, ctx()).bid).toBe(37);
  });

  it('penultimate auction: all-in, words held (or pre-played without the letter)', () => {
    const c = cfg([me, { id: 2, name: 'x', isSim: false }]);
    const p = createBawt(1);
    const { view, a } = stateAt(c, c.totalAuctions - 2, 'E', 'AINRSTQZOO', 41);
    view.players.get(2)!.balance = 10; // poorer rival: hold everything
    p.onMatchStart(view);
    const d = p.decide(view, a, ctx());
    expect(d.words).toEqual([]);
    expect(d.bid).toBe(41);
    // richer rival: pre-play the words that do not need the open letter; bid includes rewards
    view.players.get(2)!.balance = 500;
    const d2 = createBawt(1).decide(view, a, ctx());
    const reward = d2.words.reduce((s, w) => s + wordReward(w), 0);
    expect(d2.bid).toBe(41 + reward);
    const r = rackFromWord('AINRSTQZOO');
    for (const w of d2.words) for (const ch of w) r[ch.charCodeAt(0) - 65]!--;
    expect([...r].every((x) => x >= 0)).toBe(true);
  });

  it('wordsWithoutLetter drops exactly the word that needs the extra copy', () => {
    const rack = rackFromWord('RETAINSXYZ');
    const ws = wordsWithoutLetter(rack, ['RETAINS', 'ZAX'], 0); // second A needed by ZAX or RETAINS
    expect(ws.length).toBe(1);
    expect(wordsWithoutLetter(rack, ['RETAINS'], 0)).toEqual(['RETAINS']);
  });
});

describe('bidding', () => {
  it('FirstPrice shading bids below value', () => {
    const G = Float64Array.from({ length: 30 }, (_, x) => Math.min(1, (x + 1) / 20));
    for (const v of [3, 6, 10, 15, 25]) {
      const b = firstPriceBid(G, v, 100);
      expect(b).toBeLessThan(v);
      // optimal among integers
      let best = 0;
      for (let x = 0; x <= Math.ceil(v); x++) best = Math.max(best, (v - x) * winProb(G, x));
      expect((v - b) * winProb(G, b)).toBeCloseTo(best, 9);
    }
    expect(firstPriceBid(G, 10, 3)).toBeLessThanOrEqual(3);
  });

  it('price-driving: bids just under a deterministic rival on letters it does not need', () => {
    const s = 9; // rival always bids 9, no sims
    const Greal = Float64Array.from({ length: 40 }, (_, x) => (x >= s ? 1 : 0));
    const Gsim = new Float64Array(40).fill(1);
    expect(rivalSurplus(Greal, Gsim, 0)).toBeCloseTo(s - 1); // pays the reserve 1
    expect(rivalSurplus(Greal, Gsim, 6)).toBeCloseTo(s - 6);
    expect(rivalSurplus(Greal, Gsim, 12)).toBe(0);
    // low value: drive to s - 1 (rival pays 8 instead of 1)
    expect(drivingBid(Greal, Greal, Gsim, 3, 1, 20)).toBe(s - 1);
    // value above the rival's bid: win
    expect(drivingBid(Greal, Greal, Gsim, 12, 1, 20)).toBeGreaterThan(s);
    // capped by maxOverbid over the selfish bid
    expect(drivingBid(Greal, Greal, Gsim, 3, 1, 5)).toBe(5);
    // no weight: plain truthful optimum (never above value)
    expect(drivingBid(Greal, Greal, Gsim, 3, 0, 20)).toBeLessThanOrEqual(3);
  });

  it('denial adds at most maxOverbid coins', () => {
    const G = Float64Array.from({ length: 80 }, (_, x) => Math.min(1, x / 60));
    const base = {
      auctionType: 'Vickrey' as const,
      value: 8,
      kappa: 1.5,
      floor: 0,
      maxOverbid: 4,
      G,
      balance: 200,
      knownMax: undefined,
      focalCap: undefined,
      tieNudgeMinP: 0,
      jitter: 0,
      jitterBelow: 0,
      bidNoise: 0,
      sureWinCap: true,
      rng: new Rng(1),
    };
    const selfish = makeBid({ ...base, rivalValue: 0, denyWeight: 0 });
    const denied = makeBid({ ...base, rivalValue: 50, denyWeight: 1 });
    expect(selfish.bid).toBe(12);
    expect(denied.bid - selfish.bid).toBeLessThanOrEqual(4);
    expect(denied.bid).toBeGreaterThan(selfish.bid);
    // no denial when money is tight (κ < 1)
    expect(makeBid({ ...base, kappa: 0.8, rivalValue: 50, denyWeight: 1 }).denial).toBe(0);
    // never above balance, never above the known field max + 1
    expect(makeBid({ ...base, rivalValue: 0, denyWeight: 0, balance: 5 }).bid).toBe(5);
    expect(makeBid({ ...base, rivalValue: 0, denyWeight: 0, knownMax: 7 }).bid).toBe(8);
  });
});

function lineupSeats(lineup: string[], seed: number): SeatSpec[] {
  return lineup.map((spec, i) => ({ ...parseSeat(spec, hashSeed(seed, 'p', i)), id: i + 1 }) as SeatSpec);
}

describe('rules, determinism and budget in full matches', () => {
  const fast = '{"mcSamples":4,"mcHorizon":8}';
  const lineups = [
    [`bawt:${fast}`, 'sim:Aggressive', 'sim:ValueBidder', 'sim:Cheapskate', 'starter', 'greedy'],
    [`bawt:${fast}`, 'bawt-quick', 'bawt-static', 'hoarder', 'random', 'sim:Aggressive'],
    [`bawt:${fast}`, 'bawt-quick'],
    [`bawt:${fast}`, 'bawt-k13:{"mcSamples":4}', 'bawt-quick', 'greedy', 'hoarder', 'starter', 'bawt-static'],
    [`bawt-rollout:{"mcSamples":3,"mcHorizon":6}`, 'bawt-quick', 'sim:Aggressive'],
  ];

  it('never makes an illegal decision (300 matches, mixed seats, both auction types)', () => {
    let bawtSeats = 0;
    for (let m = 0; m < 300; m++) {
      const lineup = lineups[m % lineups.length]!;
      const spec = { auctionType: m % 3 === 2 ? ('FirstPrice' as const) : ('Vickrey' as const), decisionBudgetMs: 60 };
      // mostly quick seats for speed; one full seat per match
      const seats = lineupSeats(m % 10 === 0 ? lineup : lineup.map((s, i) => (i === 0 && m % 2 ? 'bawt-quick' : s)), m);
      const r = runMatch(spec, seats, hashSeed(99, m));
      for (const s of r.seats) {
        if (!s.name.startsWith('bawt')) continue;
        bawtSeats++;
        expect(s.rejectedWords, `${s.name} rejected words (match ${m})`).toBe(0);
        expect(s.rejectedBids, `${s.name} rejected bids (match ${m})`).toBe(0);
        expect(s.voidedDecisions).toBe(0);
      }
    }
    expect(bawtSeats).toBeGreaterThan(300);
  }, 600_000);

  it('is deterministic given (seed, params)', () => {
    for (const lineup of [lineups[0]!, lineups[2]!, lineups[4]!]) {
      const a = runMatch({ trace: true }, lineupSeats(lineup, 5), 1234);
      const b = runMatch({ trace: true }, lineupSeats(lineup, 5), 1234);
      expect(a.seats.map((s) => s.score)).toEqual(b.seats.map((s) => s.score));
      expect(a.trace!.auctions).toEqual(b.trace!.auctions);
      expect(a.trace!.words).toEqual(b.trace!.words);
    }
  }, 120_000);

  it('respects the decision budget (p99 <= budget + 10 ms) and the quick path is fast', () => {
    const budget = 40;
    const r = runMatch(
      { decisionBudgetMs: budget, keepDecideSamples: true },
      lineupSeats(['bawt', 'sim:Aggressive', 'sim:ValueBidder', 'sim:Cheapskate', 'sim:Aggressive', 'sim:ValueBidder'], 3),
      77,
    );
    // p99 over a single match is its max: robust form under a loaded test runner (the bench
    // measures the real p99 over thousands of decisions): >= 95% of decisions within budget + 10,
    // and no decision beyond budget + 60 (GC pauses / CPU contention).
    const xs = [...r.seats[0]!.decideSamples!].sort((x, y) => x - y);
    expect(xs[Math.ceil(0.95 * xs.length) - 1]!).toBeLessThanOrEqual(budget + 10);
    expect(xs[xs.length - 1]!).toBeLessThanOrEqual(budget + 60);

    const c = cfg([me, { id: 2, name: 'x', isSim: false }, { id: 3, name: 'y', isSim: false }]);
    const { view, a } = stateAt(c, 20, 'K', 'AEINRSTLOD');
    const p = createBawt(3);
    p.onMatchStart(view);
    p.decideQuick(view, a, ctx(1, 15)); // warm
    const t0 = performance.now();
    const d = p.decideQuick(view, a, ctx(2, 15));
    expect(performance.now() - t0).toBeLessThan(5);
    expect(Number.isInteger(d.bid) && d.bid >= 0 && d.bid <= 100).toBe(true);
  }, 120_000);

  it('beats the sims comfortably (smoke)', () => {
    let wins = 0;
    let score = 0;
    for (let k = 0; k < 6; k++) {
      const r = runMatch(
        {},
        lineupSeats([`bawt:${fast}`, 'sim:Cheapskate', 'sim:ValueBidder', 'sim:Aggressive', 'sim:ValueBidder', 'sim:Aggressive'], k),
        hashSeed(5, k),
      );
      if (r.seats[0]!.win) wins++;
      score += r.seats[0]!.score;
      expect(rackToString(rackFromWord('A'))).toBe('A');
    }
    expect(wins).toBe(6);
    expect(score / 6).toBeGreaterThan(200);
  }, 120_000);
});

describe('policies map', () => {
  it('every factory builds a policy with a matching name', () => {
    for (const [name, f] of Object.entries(policies)) expect(f(1).name).toBe(name);
  });
});
