// 03-02 Task 2: data-fitted clones (LUCENT, Bron, maverick) and the profile-driven clone.
import { describe, expect, it } from 'vitest';
import { BAG, LETTERS, NUM_LETTERS, idx, totalAuctions, wordReward } from '../../src/core/letters.js';
import { rackFromWord } from '../../src/core/rack.js';
import { Rng } from '../../src/core/rng.js';
import type { AuctionInfo, DecideContext, MatchConfig, Policy } from '../../src/core/types.js';
import { createPolicy, listFamilies, parseSeat } from '../../src/bots/registry.js';
import { BRON_CALIBRATION } from '../../src/bots/clones/bron.js';
import {
  FITTED_NAMES,
  FITTED_TARGETS,
  NOW_TABLES,
  evaluateFitted,
  relErr,
  tableSchedule,
} from '../../src/bots/clones/calibration.js';
import { LUCENT_CALIBRATION } from '../../src/bots/clones/lucent.js';
import { MAVERICK_CALIBRATION } from '../../src/bots/clones/maverick.js';
import { partition } from '../../src/bots/clones/common.js';
import { findProfile, loadProfiles, profileWordPolicy, sampleCurve } from '../../src/bots/clones/profile.js';
import { MatchTracker } from '../../src/state/tracker.js';
import { runMatch, type SeatSpec } from '../../src/sim/match.js';

function cfg(n: number): MatchConfig {
  return {
    matchId: 1,
    auctionType: 'Vickrey',
    auctionDurationMs: 1000,
    startingRackSize: 5,
    startingBalance: 100,
    players: Array.from({ length: n }, (_, k) => ({ id: k + 1, name: `p${k + 1}`, isSim: false })),
    myId: 1,
    totalAuctions: totalAuctions(n, 5),
  };
}

const ctx = (seed = 1): DecideContext => ({ budgetMs: 250, rng: new Rng(seed), now: () => performance.now() });

function viewAt(policy: Policy, c: MatchConfig, start: string, index: number, letter: string) {
  const tracker = new MatchTracker(c, rackFromWord(start));
  policy.onMatchStart(tracker.view);
  const bag: number[] = [...BAG];
  for (const ch of start) bag[idx(ch)]!--;
  bag[idx(letter)]!--;
  let li = 0;
  const at = (k: number, l: string): AuctionInfo => ({
    auctionId: k + 1,
    index: k,
    letter: l,
    opensAtMs: k * 1001.5,
    closesAtMs: k * 1001.5 + 1000,
    remainingAfter: c.totalAuctions - k - 1,
  });
  for (let k = 0; k < index; k++) {
    while (bag[li]! === 0) li = (li + 1) % NUM_LETTERS;
    bag[li]!--;
    const a = at(k, LETTERS[li]!);
    tracker.auctionOpen(a);
    tracker.auctionResult({ auctionId: a.auctionId, index: k, letter: a.letter, winnerId: null, paid: 0 });
  }
  const a = at(index, letter);
  tracker.auctionOpen(a);
  return { view: tracker.view, auction: a };
}

const CALIBRATED = {
  'clone:lucent': LUCENT_CALIBRATION,
  'clone:bron': BRON_CALIBRATION,
  'clone:maverick': MAVERICK_CALIBRATION,
};

describe('data-fitted clones', () => {
  it('NOW table schedule follows the NOW composition (599 of the 600 matches; see calibration.ts)', () => {
    const s = tableSchedule(599);
    NOW_TABLES.forEach((t, i) => expect(s.filter((x) => x === i).length).toBe(t.weight));
    // Bron sits in every NOW match, LUCENT in 490, maverick in 473
    const seats = (name: string) => NOW_TABLES.filter((t) => t.clones.includes(name)).reduce((a, t) => a + t.weight, 0);
    expect(seats('clone:bron')).toBe(599);
    expect(seats('clone:lucent')).toBe(490);
    expect(seats('clone:maverick')).toBe(473);
  });

  it('calibrated constants reproduce the NOW targets (120-match smoke of the 500-match calibration)', async () => {
    const ev = await evaluateFitted(CALIBRATED, 120, 7, 0);
    for (const n of FITTED_NAMES) {
      const m = ev.metrics[n]!;
      const t = FITTED_TARGETS[n]!;
      expect(Math.abs(relErr(m.tiles, t.tiles)), `${n} tiles ${m.tiles}`).toBeLessThan(0.15);
      expect(Math.abs(relErr(m.words, t.words)), `${n} words ${m.words}`).toBeLessThan(0.2);
      expect(Math.abs(relErr(m.paidPerTile, t.paidPerTile)), `${n} paid ${m.paidPerTile}`).toBeLessThan(0.25);
      // documented gap: end balance follows score, which the fitted bidders under-produce
      expect(Math.abs(relErr(m.endBalance, t.endBalance)), `${n} end ${m.endBalance}`).toBeLessThan(0.6);
    }
    // finishing order among the three matches history: LUCENT > Bron > maverick
    expect(ev.headToHead['clone:lucent']!['clone:bron']!).toBeGreaterThan(0.5);
    expect(ev.headToHead['clone:bron']!['clone:maverick']!).toBeGreaterThan(0.5);
    expect(ev.headToHead['clone:lucent']!['clone:maverick']!).toBeGreaterThan(0.5);
  }, 120_000);

  it('final auction: bid 0 and dump; penultimate: penFrac x balance on a useful letter', () => {
    const c = cfg(3);
    for (const [name, cal] of Object.entries(CALIBRATED)) {
      const pol = createPolicy(name, 1);
      const fin = viewAt(pol, c, 'RETIN', c.totalAuctions - 1, 'E');
      const d = pol.decide(fin.view, fin.auction, ctx());
      expect(d.bid, name).toBe(0);
      expect(d.words.length, name).toBeGreaterThan(0);
      const pol2 = createPolicy(name, 1);
      const pen = viewAt(pol2, c, 'RETIN', c.totalAuctions - 2, 'A');
      const d2 = pol2.decide(pen.view, pen.auction, ctx());
      // LUCENT/maverick (dumpT 3) dump first, raising the balance; then penFrac applies on a gain
      const bal = 100 + d2.words.reduce((a, w) => a + wordReward(w), 0);
      const rest = rackFromWord('RETIN');
      for (const w of d2.words) for (const ch of w) rest[idx(ch)]!--;
      const withA = new Uint8Array(rest);
      withA[idx('A')]!++;
      const gain = partition(withA).score - partition(rest).score;
      expect(d2.bid, name).toBe(gain > 0 ? Math.floor(cal.penFrac * bal) : 0);
      if (name === 'clone:bron') expect(d2.bid).toBe(Math.floor(cal.penFrac * 100)); // RETIN + A = RETINA
    }
  });

  it('server rules in the NOW mix and in all-real tables', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const specs = ['clone:lucent', 'clone:bron', 'clone:maverick', 'clone:k13', 'clone:lionel', 'profile:Waupus'];
      const seats = specs.map((s, k) => ({ id: k + 1, ...parseSeat(s, seed * 7 + k) }) as SeatSpec);
      const r = runMatch({}, seats, seed);
      for (const s of r.seats) {
        expect(s.rejectedBids, `${s.name} seed ${seed}`).toBe(0);
        expect(s.rejectedWords, `${s.name} seed ${seed}`).toBe(0);
      }
    }
  }, 60_000);
});

describe('profile-driven clone', () => {
  it('resolves profile:<BotName> through the registry wildcard (case-insensitive), rejects unknown bots', () => {
    expect(listFamilies()).toContain('profile:*');
    expect(createPolicy('profile:Waupus', 1).name).toBe('profile:Waupus');
    expect(createPolicy('profile:waupus', 1).name).toBe('profile:Waupus');
    expect(createPolicy('profile:Lambi Lambiii', 1).name).toBe('profile:Lambi Lambiii');
    expect(() => createPolicy('profile:NoSuchBot', 1)).toThrow(/no bot/);
  });

  it('inverse-CDF sampling of a survival curve', () => {
    const curve = { n: 100, nExact: 50, pNoBid: 0.1, q50: 5, q75: 7, q90: 9, pGe: [0.9, 0.8, 0.5, 0.2, 0] };
    expect(sampleCurve(curve, 0.95)).toBe(0);
    expect(sampleCurve(curve, 0.85)).toBe(1);
    expect(sampleCurve(curve, 0.6)).toBe(2);
    expect(sampleCurve(curve, 0.3)).toBe(3);
    expect(sampleCurve(curve, 0.1)).toBe(4);
    expect(sampleCurve(curve, 0)).toBe(4);
  });

  it('word policy from the profile: LUCENT and Bron cash 7+ mid-match; Waupus flushes at the final auction', () => {
    expect(profileWordPolicy(findProfile('LUCENT')).midMinLen).toBe(7);
    expect(profileWordPolicy(findProfile('Bron')).midMinLen).toBe(7);
    const w = profileWordPolicy(findProfile('Waupus'));
    expect(w.flushT).toBe(1);
  });

  it('bids follow the profiled distribution: sampled early vowel bids of Bron have about its KM median', () => {
    const bron = findProfile('Bron');
    const curve = bron.bidCurves.vowel.early;
    const c = cfg(6);
    const pol = createPolicy('profile:Bron', 3);
    const { view, auction } = viewAt(pol, c, 'QQXZJ', 3, 'E'); // useless rack: need factor at its floor
    const bids: number[] = [];
    for (let s = 0; s < 400; s++) bids.push(pol.decide(view, auction, ctx(s)).bid);
    bids.sort((a, b) => a - b);
    const med = bids[200]!;
    // need factor at s = 0: needLo / needMean = 0.78
    expect(med).toBeGreaterThanOrEqual(Math.floor(curve.q50 * 0.78) - 2);
    expect(med).toBeLessThanOrEqual(Math.ceil(curve.q50 * 0.78) + 2);
  });

  it('every profiled bot plays a legal match', () => {
    const names = loadProfiles().bots.map((b) => b.name);
    expect(names.length).toBeGreaterThan(50);
    for (let k = 0; k < names.length; k += 6) {
      const lineup = names.slice(k, k + 6).map((n) => `profile:${n}`);
      while (lineup.length < 2) lineup.push('starter');
      const seats = lineup.map((s, j) => ({ id: j + 1, ...parseSeat(s, k + j) }) as SeatSpec);
      const r = runMatch({}, seats, k + 1);
      for (const s of r.seats) {
        expect(s.rejectedBids, s.name).toBe(0);
        expect(s.rejectedWords, s.name).toBe(0);
      }
    }
  }, 60_000);
});
