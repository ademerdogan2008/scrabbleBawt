// Opponent profiles: committed data/profiles.json schema + sanity, KM estimator recovery, phases,
// and deterministic rebuild on the sample.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LETTERS, idx } from '../../src/core/letters.js';
import { Rng } from '../../src/core/rng.js';
import { simBid } from '../../src/core/simbots.js';
import { KmAccumulator, reverseKMFromObs } from '../../src/history/km.js';
import { loadMatches } from '../../src/history/load.js';
import {
  BID_X_MAX,
  FINALISTS,
  GROUPS,
  LETTER_GROUPS,
  PHASES,
  buildProfiles,
  checkProfiles,
  groupOf,
  pBidAtLeast,
  phaseOf,
  type ProfilesFile,
} from '../../src/history/profiles.js';

const ROOT = path.join(__dirname, '..', '..');
const PROFILES = path.join(ROOT, 'data', 'profiles.json');

describe('data/profiles.json (generated from the full dataset)', () => {
  const raw = fs.readFileSync(PROFILES, 'utf8');
  const P = JSON.parse(raw) as ProfilesFile;
  const byName = new Map(P.bots.map((b) => [b.name, b]));

  it('is schema v1, valid, <= 3 MB, with generatedFrom metadata', () => {
    expect(raw.length).toBeLessThanOrEqual(3_000_000);
    expect(P.schemaVersion).toBe(1);
    expect(checkProfiles(P)).toEqual([]);
    expect(P.generatedFrom.completeMatches).toBeGreaterThan(25_000);
    expect(P.generatedFrom.matchIdRange[0]).toBeLessThan(P.generatedFrom.matchIdRange[1]);
    expect(P.generatedFrom.startedRange[0] < P.generatedFrom.startedRange[1]).toBe(true);
    expect(P.definitions.letterGroups).toEqual(LETTER_GROUPS);
  });

  it('profiles >= 15 bots including every tournament finalist', () => {
    expect(P.bots.length).toBeGreaterThanOrEqual(15);
    for (const f of FINALISTS) expect(byName.has(f), f).toBe(true);
    for (const n of ['Bron', 'LUCENT', 'maverick-bot', 'Lionel', 'Nijello', 'Lala']) expect(byName.has(n), n).toBe(true);
    for (const b of P.bots) {
      expect(b.matches >= 150 || b.finalist, b.name).toBe(true);
      expect(b.modelMatches).toBeLessThanOrEqual(Math.min(3000, b.matches));
    }
  });

  it('survival curves are monotone non-increasing probabilities of length 60', () => {
    const bad: string[] = [];
    let curves = 0;
    for (const b of P.bots) {
      for (const g of GROUPS) {
        for (const c of [...PHASES.map((p) => b.bidCurves[g][p]), b.bidCurvesAllPhases[g]]) {
          curves++;
          if (c.pGe.length !== BID_X_MAX) bad.push(`${b.name}/${g}: length ${c.pGe.length}`);
          for (let i = 0; i < c.pGe.length; i++) {
            const p = c.pGe[i]!;
            if (!(p >= 0 && p <= 1)) bad.push(`${b.name}/${g}: pGe[${i}] = ${p}`);
            if (i > 0 && p > c.pGe[i - 1]!) bad.push(`${b.name}/${g}: increases at x=${i + 1}`);
          }
        }
      }
    }
    expect(curves).toBe(P.bots.length * GROUPS.length * (PHASES.length + 1));
    expect(bad).toEqual([]);
  });

  it("detects Bron's hard cap of 30 on J/X/Q/Z and its penultimate all-in habit", () => {
    const bron = byName.get('Bron')!;
    for (const L of 'JXQZ') {
      const cap = bron.caps.find((c) => c.letter === L)!;
      expect(cap.cap, L).toBe(30);
      expect(cap.modeShare).toBeGreaterThan(0.25);
    }
    expect(bron.caps.find((c) => c.letter === 'E')!.cap).toBeNull();
    expect(bron.penultimate.allInRateOfWins!).toBeGreaterThan(0.4);
    expect(bron.final.winRate).toBe(0);
    // Matches HISTORICAL.md §C1 (current version, all matches).
    expect(bron.buying.lettersWonPerMatch!).toBeCloseTo(21.97, 1);
    expect(bron.buying.avgPaid!).toBeCloseTo(8.32, 1);
    expect(byName.get('Waupus')!.results.all.winRate!).toBeCloseTo(0.528, 2);
    expect(bron.regression.coef.value!).toBeGreaterThan(1);
  });

  it("sims' curves are consistent with the exact simBid ranges", () => {
    const sims = P.bots.filter((b) => b.isSim);
    expect(sims).toHaveLength(6);
    for (const s of sims) {
      expect(s.simStrategy).toBeDefined();
      for (const g of GROUPS) {
        // groups are uniform in face value, so one letter determines the sim's bid range
        const li = idx(LETTER_GROUPS[g][0]!);
        const maxBid = simBid(s.simStrategy!, li, 1000, 2);
        for (const c of [...PHASES.map((p) => s.bidCurves[g][p]), s.bidCurvesAllPhases[g]]) {
          for (let x = maxBid + 1; x <= BID_X_MAX; x++) expect(pBidAtLeast(c, x), `${s.name} ${g} x=${x}`).toBe(0);
        }
        const all = s.bidCurvesAllPhases[g];
        if (all.nExact >= 50) expect(pBidAtLeast(all, maxBid), `${s.name} ${g} at max`).toBeGreaterThan(0);
      }
      // sims never win more than they can bid: caps (if detected) never exceed the max sim bid
      for (const c of s.caps) expect(c.maxTop).toBeLessThanOrEqual(simBid(s.simStrategy!, idx(c.letter), 1000, 2));
    }
  });

  it('market priors cover every letter and the 68-auction index curve', () => {
    for (const p of PHASES) for (const l of [...LETTERS, 'ALL']) expect(P.market.priceByPhase.all[p][l]).toBeDefined();
    expect(P.market.indexCurve68.all).toHaveLength(68);
    const final = P.market.indexCurve68.all[67]!;
    expect(final.noBid!).toBeGreaterThan(0.3); // HISTORICAL.md §C5: 41.2%
    expect(P.market.indexCurve68.recent[66]!.meanTop!).toBeGreaterThan(40); // penultimate dump (~50.6)
  });
});

describe('phases and letter groups', () => {
  it('phases are disjoint as documented', () => {
    const T = 68;
    const got = Array.from({ length: T }, (_, k) => phaseOf(k, T));
    expect(got[67]).toBe('final');
    expect(got[66]).toBe('penultimate');
    expect(got[65]).toBe('late');
    expect(got[46]).toBe('late');
    expect(got[45]).toBe('mid');
    expect(got[23]).toBe('mid');
    expect(got[22]).toBe('early');
    expect(got.filter((p) => p === 'early')).toHaveLength(23);
    expect(phaseOf(86, 88)).toBe('penultimate');
  });

  it('every letter belongs to exactly one group', () => {
    const seen = GROUPS.flatMap((g) => [...LETTER_GROUPS[g]]).sort().join('');
    expect(seen).toBe(LETTERS);
    expect(groupOf('Y')).toBe('FHVWY');
    expect(groupOf('E')).toBe('vowel');
  });
});

describe('reverse Kaplan-Meier', () => {
  const synth = (seed: number, coinTies: boolean) => {
    const rng = new Rng(seed);
    const acc = new KmAccumulator();
    for (let i = 0; i < 60_000; i++) {
      const bid = rng.int(1, 20); // true P(bid >= x) = (21 - x) / 20
      const field = rng.int(0, 25); // max of the other bids, independent of ours
      const win = bid > field || (coinTies && bid === field && rng.int(0, 1) === 1);
      if (win) acc.add(bid, true);
      else acc.add(field, false); // loss: bid <= winner's top bid
    }
    return acc;
  };
  const maxErr = (pGe: number[], from: number, to: number) => {
    let e = 0;
    for (let x = from; x <= to; x++) e = Math.max(e, Math.abs(pGe[x - 1]! - (21 - x) / 20));
    return e;
  };

  it('recovers a known bid distribution under left-censoring with coin-flip ties (server rule)', () => {
    const c = synth(7, true).curve(30); // default tieWeight 0.5
    expect(maxErr(c.pGe, 2, 20)).toBeLessThan(0.012);
    for (let x = 21; x <= 30; x++) expect(c.pGe[x - 1]).toBe(0);
    expect(c.q90).toBeGreaterThanOrEqual(18);
  });

  it('tieWeight 0 is unbiased when ties are always lost; textbook KM (1) is biased low', () => {
    const acc = synth(8, false);
    expect(maxErr(acc.curve(30, 4, 0).pGe, 2, 20)).toBeLessThan(0.01);
    const textbook = acc.curve(30, 4, 1).pGe;
    expect(maxErr(textbook, 2, 20)).toBeGreaterThan(0.03);
    expect(textbook[5]!).toBeLessThan((21 - 6) / 20);
  });

  it('handles all-exact, all-censored and empty inputs', () => {
    const exact = reverseKMFromObs([
      [3, true],
      [5, true],
      [5, true],
      [10, true],
    ]);
    expect(exact.pGe.slice(0, 11)).toEqual([1, 1, 1, 0.75, 0.75, 0.25, 0.25, 0.25, 0.25, 0.25, 0]);
    expect(exact.q50).toBe(5);
    const cens = reverseKMFromObs([
      [10, false],
      [4, false],
    ]);
    expect(cens.pGe.every((p) => p === 0)).toBe(true);
    const empty = new KmAccumulator().curve(5);
    expect(empty.pGe).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('buildProfiles on the committed sample', async () => {
  const D = await loadMatches(path.join(ROOT, 'data', 'history-sample'));
  it('is valid and deterministic', () => {
    const a = buildProfiles(D, { minMatches: 40 });
    const b = buildProfiles(D, { minMatches: 40 });
    expect(checkProfiles(a)).toEqual([]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.generatedFrom.excludedIncomplete).toBe(1);
    expect(a.bots.some((x) => x.name === 'Bron')).toBe(true);
    expect(a.bots.some((x) => x.name === 'K-13')).toBe(true); // finalist regardless of count
  });
});
