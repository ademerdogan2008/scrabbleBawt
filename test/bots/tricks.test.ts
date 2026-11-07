// 03-02 Task 3: trick zoo (PITFALLS.md catalog, COMPETITORS.md §4.10 / §7) and named lineups.
import { describe, expect, it } from 'vitest';
import { BAG, LETTERS, NUM_LETTERS, VALUE, idx, totalAuctions } from '../../src/core/letters.js';
import { rackFromWord } from '../../src/core/rack.js';
import { Rng } from '../../src/core/rng.js';
import { simMaxBid } from '../../src/core/simbots.js';
import type { AuctionInfo, DecideContext, MatchConfig, Policy } from '../../src/core/types.js';
import { createHoarder, createRandom } from '../../src/bots/baselines/index.js';
import { ALLREAL_PRICE, NOW_PRICE } from '../../src/bots/clones/common.js';
import { BENCH_LINEUPS, LINEUPS, LINEUP_NAMES, getLineup, resolveLineup } from '../../src/bots/lineups.js';
import { createPolicy, listPolicies, parseSeat } from '../../src/bots/registry.js';
import { TRICKS } from '../../src/bots/tricks/index.js';
import { MatchTracker } from '../../src/state/tracker.js';
import { runMatch, type MatchResult, type SeatSpec } from '../../src/sim/match.js';

function cfg(n: number, sims: number[] = []): MatchConfig {
  return {
    matchId: 1,
    auctionType: 'Vickrey',
    auctionDurationMs: 1000,
    startingRackSize: 5,
    startingBalance: 100,
    players: Array.from({ length: n }, (_, k) => ({
      id: k + 1,
      name: `p${k + 1}`,
      isSim: sims.includes(k + 1),
      ...(sims.includes(k + 1) ? { simStrategy: 'Aggressive' as const } : {}),
    })),
    myId: 1,
    totalAuctions: totalAuctions(n, 5),
  };
}

const ctx = (seed = 1): DecideContext => ({ budgetMs: 250, rng: new Rng(seed), now: () => performance.now() });

function at(c: MatchConfig, k: number, letter: string): AuctionInfo {
  return { auctionId: k + 1, index: k, letter, opensAtMs: k * 1001.5, closesAtMs: k * 1001.5 + 1000, remainingAfter: c.totalAuctions - k - 1 };
}

/** Tracker advanced (no winners unless `winners` says so) to auction `index`, which is open. */
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
    const a = at(c, k, LETTERS[li]!);
    tracker.auctionOpen(a);
    const o = { auctionId: a.auctionId, index: k, letter: a.letter, winnerId: null, paid: 0 };
    tracker.auctionResult(o);
    policy.onAuctionClosed?.(tracker.view, o);
  }
  const a = at(c, index, letter);
  tracker.auctionOpen(a);
  return { view: tracker.view, auction: a, tracker };
}

function play(lineup: readonly string[], seed: number, spec: Parameters<typeof runMatch>[0] = {}): MatchResult {
  const seats = lineup.map((s, k) => ({ id: k + 1, ...parseSeat(s, seed * 13 + k) }) as SeatSpec);
  return runMatch({ trace: true, ...spec }, seats, seed);
}

describe('trick zoo: registry', () => {
  it('registers the >= 9 required tricks plus hoarder/random wrappers', () => {
    const names = listPolicies();
    for (const t of ['allin', 'shadow', 'late', 'jitter', 'sniper', 'bottomFeeder', 'endgameDumper', 'oracleDenier', 'spite', 'hoarder', 'random']) {
      expect(names).toContain(`trick:${t}`);
    }
    for (const t of TRICKS) expect(createPolicy(t, 1).name).toBe(t);
  });
});

describe('trick zoo: behaviour', () => {
  it('allin: never plays words; 1.5-2x the ALLREAL market on face <= 2 letters, nothing else', () => {
    const r = play(['trick:allin', 'starter', 'sim:Aggressive'], 3);
    const s = r.seats.find((x) => x.id === 1)!;
    expect(s.wordsPlayed).toBe(0);
    expect(s.score).toBe(0);
    let bal = 100;
    for (const a of r.trace!.auctions) {
      const b = a.bids[1] ?? 0;
      const li = idx(a.letter);
      if (VALUE[li]! > 2 || bal === 0) expect(b).toBe(0);
      else {
        expect(b).toBeGreaterThanOrEqual(Math.min(bal, Math.floor(1.5 * ALLREAL_PRICE[li]!)));
        expect(b).toBeLessThanOrEqual(Math.min(bal, Math.ceil(2 * ALLREAL_PRICE[li]!)));
      }
      if (a.winnerId === 1) bal -= a.paid;
    }
  });

  it('bottomFeeder: bids exactly 1 on every auction while solvent and plays greedy words', () => {
    const r = play(['trick:bottomFeeder', 'trick:allin', 'trick:late'], 4); // nobody else bids on most letters
    let bal = 100;
    for (const a of r.trace!.auctions) {
      expect(a.bids[1] ?? 0).toBe(Math.min(1, bal));
      if (a.winnerId === 1) bal -= a.paid;
      for (const w of r.trace!.words) if (w.seatId === 1 && w.index === a.index) bal += w.reward;
    }
    expect(r.seats.find((x) => x.id === 1)!.lettersWon).toBeGreaterThan(0);
  });

  it('late: 0 before the last 15 auctions, then bids', () => {
    const r = play(['trick:late', 'starter', 'sim:Cheapskate'], 5);
    const T = r.auctions;
    let lateBids = 0;
    for (const a of r.trace!.auctions) {
      const left = T - a.index; // auctions left including this one
      if (left > 15 || left === 1) expect(a.bids[1] ?? 0).toBe(0);
      else if ((a.bids[1] ?? 0) > 0) lateBids++;
    }
    expect(lateBids).toBeGreaterThan(5);
  });

  it('endgameDumper: whole balance at B == 1, thrifty before the window', () => {
    const c = cfg(3);
    const pol = createPolicy('trick:endgameDumper', 1);
    const pen = viewAt(pol, c, 'QQXZJ', c.totalAuctions - 2, 'E');
    expect(pol.decide(pen.view, pen.auction, ctx()).bid).toBe(100);
    const pol2 = createPolicy('trick:endgameDumper', 1);
    const early = viewAt(pol2, c, 'RETIN', 3, 'A');
    expect(pol2.decide(early.view, early.auction, ctx()).bid).toBeLessThanOrEqual(Math.ceil(0.5 * NOW_PRICE[idx('A')]!));
  });

  it('sniper: exactly simMax + 1 on a useful letter when only sims compete', () => {
    const c = cfg(3, [2, 3]);
    const pol = createPolicy('trick:sniper', 1);
    const { view, auction } = viewAt(pol, c, 'RETIN', 5, 'A');
    expect(pol.decide(view, auction, ctx()).bid).toBe(simMaxBid('Aggressive', idx('A'), 100) + 1);
    // a solvent real rival competes: the sniper bids low (<= face + 1)
    const c2 = cfg(3, [3]);
    const pol2 = createPolicy('trick:sniper', 1);
    const v2 = viewAt(pol2, c2, 'RETIN', 5, 'A');
    expect(pol2.decide(v2.view, v2.auction, ctx()).bid).toBeLessThanOrEqual(VALUE[idx('A')]! + 1);
  });

  it('oracleDenier: denies a letter completing the leader TRUE-rack 7+ word, only with oracle racks', () => {
    const c = cfg(2);
    const pol = createPolicy('trick:oracleDenier', 1) as Policy & { denials: number };
    const { view, auction } = viewAt(pol, c, 'QQXZJ', 10, 'A');
    const truth = new Map([
      [1, rackFromWord('QQXZJ')],
      [2, rackFromWord('RETINS')], // + A = RETAINS / RETINAS / STAINER ...
    ]);
    pol.onOracle!(truth);
    const d = pol.decide(view, auction, ctx());
    expect(d.bid).toBeGreaterThanOrEqual(20);
    expect(pol.denials).toBe(1);
    const blind = createPolicy('trick:oracleDenier', 1) as Policy & { denials: number };
    const v2 = viewAt(blind, c, 'QQXZJ', 10, 'A');
    blind.decide(v2.view, v2.auction, ctx());
    expect(blind.denials).toBe(0); // public knownHeld of the rival is empty
  });

  it('oracleDenier seated as oracle:<spec> receives racks in the simulator', () => {
    const t = parseSeat('oracle:trick:oracleDenier', 1);
    expect(t).toMatchObject({ kind: 'policy', oracle: true });
    const seats = [
      { id: 1, ...t } as SeatSpec,
      { id: 2, ...parseSeat('clone:lionel', 2) } as SeatSpec,
      { id: 3, ...parseSeat('clone:lala', 3) } as SeatSpec,
    ];
    runMatch({}, seats, 8);
    const pol = (seats[0] as unknown as { policy: Policy & { sawOracle: boolean; denials: number } }).policy;
    expect(pol.sawOracle).toBe(true);
    expect(pol.denials).toBeGreaterThan(0);
  }, 30_000);

  it('shadow: bids 0.85 x the leader estimate (NOW prior 1.2 x market before observations)', () => {
    const c = cfg(3);
    const pol = createPolicy('trick:shadow', 1);
    const { view, auction } = viewAt(pol, c, 'QQXZJ', 2, 'E');
    expect(pol.decide(view, auction, ctx()).bid).toBe(Math.floor(0.85 * 1.2 * NOW_PRICE[idx('E')]!));
  });

  it('spite: just under the predicted opponent bid on a letter it does not need', () => {
    const c = cfg(2);
    const pol = createPolicy('trick:spite', 1);
    const { view, auction } = viewAt(pol, c, 'QQXZJ', 2, 'V'); // V adds nothing to QQXZJ
    expect(pol.decide(view, auction, ctx()).bid).toBe(Math.floor(1.2 * NOW_PRICE[idx('V')]! - 1));
  });

  it('hoarder/random wrappers reproduce the 02-01 baselines (bids; hoarder flush bounded)', () => {
    const c = cfg(3);
    for (const [k, letter] of [...'EAQZS'].entries()) {
      const a = createPolicy('trick:hoarder', 1);
      const b = createHoarder(1);
      const va = viewAt(a, c, 'RETIN', 10 + k, letter);
      const vb = viewAt(b, c, 'RETIN', 10 + k, letter);
      const da = a.decide(va.view, va.auction, ctx(k));
      const db = b.decide(vb.view, vb.auction, ctx(k));
      expect(da).toEqual(db);
      const r = createPolicy('trick:random', 1);
      const r0 = createRandom(1);
      const vr = viewAt(r, c, 'RETIN', 10 + k, letter);
      const vr0 = viewAt(r0, c, 'RETIN', 10 + k, letter);
      expect(r.decide(vr.view, vr.auction, ctx(k))).toEqual(r0.decide(vr0.view, vr0.auction, ctx(k)));
    }
    const h = createPolicy('trick:hoarder', 1);
    const fin = viewAt(h, c, 'RETINAS', c.totalAuctions - 2, 'E');
    expect(h.decide(fin.view, fin.auction, ctx()).words.length).toBeGreaterThan(0);
  });
});

describe('named lineups', () => {
  it('exports the plan lineups with one focal seat each', () => {
    expect([...BENCH_LINEUPS]).toEqual([
      'lobbyNow',
      'lobbySims',
      'fullTable',
      'bigTable',
      'headsUpK13',
      'tricks',
      'oracle',
      'firstPrice',
      'starterFlood',
    ]);
    for (const n of LINEUP_NAMES) expect(getLineup(n).seats.filter((s) => s === '*').length).toBe(1);
    expect(LINEUPS.lobbyNow.seats).toEqual(['*', 'clone:lucent', 'clone:bron', 'clone:maverick', 'sim:Aggressive', 'sim:ValueBidder']);
    expect(LINEUPS.fullTable.seats).toEqual(['*', 'clone:k13', 'clone:lionel', 'clone:nijello', 'clone:lala', 'profile:Waupus']);
    expect(LINEUPS.bigTable.seats.length).toBe(7);
    expect(LINEUPS.bigTable.seats).toContain('clone:sookra');
    expect(LINEUPS.headsUpK13.seats).toEqual(['*', 'clone:k13']);
    expect(LINEUPS.firstPrice.spec).toEqual({ auctionType: 'FirstPrice' });
    expect(LINEUPS.starterFlood.seats.filter((s) => s === 'starter').length).toBe(5);
    expect(resolveLineup('tricks', 'greedy')[0]).toBe('greedy');
    expect(() => getLineup('nope')).toThrow(/unknown lineup/);
  });

  it('every seat of every lineup resolves through the registry', () => {
    for (const n of LINEUP_NAMES) for (const s of resolveLineup(n, 'starter')) expect(() => parseSeat(s, 1)).not.toThrow();
  });

  it('every zoo policy appears in at least one lineup', () => {
    const used = new Set(LINEUP_NAMES.flatMap((n) => getLineup(n).seats.map((s) => s.replace(/^oracle:/, ''))));
    const zoo = listPolicies().filter((p) => p.startsWith('clone:') || p.startsWith('trick:'));
    for (const p of zoo) expect(used.has(p), p).toBe(true);
    expect([...used].some((s) => s.startsWith('profile:'))).toBe(true);
  });

  it('every lineup plays legal matches with starter in the focal seat (1 seed each)', () => {
    for (const n of LINEUP_NAMES) {
      const l = getLineup(n);
      const r = play(resolveLineup(l, 'starter'), 21, { ...(l.spec ?? {}), trace: false });
      expect(r.auctions, n).toBe(98 - 5 * l.seats.length);
      for (const s of r.seats) {
        expect(s.rejectedBids, `${n} ${s.name}`).toBe(0);
        expect(s.rejectedWords, `${n} ${s.name}`).toBe(0);
      }
    }
  }, 120_000);
});
